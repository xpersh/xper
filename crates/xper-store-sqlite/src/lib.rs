//! Transactional SQLite event log and disposable run projections.
//!
//! The event stream is authoritative. Materialized tables are rebuilt from it
//! on open and after each boundary. A failed disk open can fall back to a
//! process-local store, allowing the workflow to continue without durability.

use std::{
    collections::BTreeMap,
    error::Error as StdError,
    fmt,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use xper_application::events::{
    EVENT_SCHEMA_VERSION, Event, EventKind, EventStore, RunProjection, WorkOutcome, replay,
};

/// Stable package identity used by workspace dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_initial.sql"))];

/// A store failure. A boundary is rolled back if any operation fails.
#[derive(Debug)]
pub enum StoreError {
    /// SQLite rejected an operation.
    Sqlite(rusqlite::Error),
    /// A stored event or projection is not valid JSON.
    Json(serde_json::Error),
    /// Ordered events do not form a valid run.
    InvalidHistory(String),
    /// An event ID was reused with different content.
    EventIdConflict(String),
    /// The database contains a newer schema or event version.
    UnsupportedSchema(i64),
    /// A timestamp cannot fit SQLite's signed integer type.
    TimestampOverflow,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "SQLite: {e}"),
            Self::Json(e) => write!(f, "event JSON: {e}"),
            Self::InvalidHistory(e) => write!(f, "invalid event history: {e}"),
            Self::EventIdConflict(id) => write!(f, "event ID reused with different content: {id}"),
            Self::UnsupportedSchema(v) => write!(f, "unsupported schema version: {v}"),
            Self::TimestampOverflow => f.write_str("timestamp exceeds SQLite integer range"),
        }
    }
}
impl StdError for StoreError {}
impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Whether event records survive process exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    /// Events are saved to the configured database.
    Persistent,
    /// Events are held only for the current process.
    Volatile,
}

/// The single-writer SQLite adapter. Independent read connections may use WAL.
pub struct SqliteEventStore {
    connection: Connection,
    durability: Durability,
    degraded_reason: Option<String>,
}

impl SqliteEventStore {
    /// Opens a persistent database, migrates it, rebuilds projections, and
    /// records an interrupted event for every attempt lacking a final event.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let mut store = Self {
            connection,
            durability: Durability::Persistent,
            degraded_reason: None,
        };
        store.migrate()?;
        store.rebuild_all()?;
        store.recover_interrupted()?;
        Ok(store)
    }

    /// Opens a memory-backed store for tests or explicit ephemeral use.
    pub fn in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self {
            connection,
            durability: Durability::Volatile,
            degraded_reason: None,
        };
        store.migrate()?;
        Ok(store)
    }

    /// Continues in memory if the configured database cannot be opened.
    /// Callers can surface `degraded_reason` as a warning.
    pub fn open_or_volatile(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        match Self::open(path) {
            Ok(store) => Ok(store),
            Err(error) => {
                let mut store = Self::in_memory()?;
                store.degraded_reason = Some(error.to_string());
                Ok(store)
            }
        }
    }

    /// Reports whether the current store is durable.
    #[must_use]
    pub const fn durability(&self) -> Durability {
        self.durability
    }

    /// Why the persistent store was unavailable, if fallback occurred.
    #[must_use]
    pub fn degraded_reason(&self) -> Option<&str> {
        self.degraded_reason.as_deref()
    }

    /// Applies an entire domain boundary atomically. Duplicate identical
    /// event IDs have no effect; conflicting reuse aborts the whole boundary.
    pub fn append_boundary(&mut self, events: &[Event]) -> Result<usize, StoreError> {
        if events.is_empty() {
            return Ok(0);
        }
        let run_id = &events[0].run_id;
        if events.iter().any(|e| e.run_id != *run_id) {
            return Err(StoreError::InvalidHistory(
                "boundary spans multiple runs".into(),
            ));
        }
        let tx = self.connection.transaction()?;
        let mut inserted = 0;
        for event in events {
            let json = serde_json::to_string(event)?;
            let existing: Option<String> = tx
                .query_row(
                    "SELECT event_json FROM events WHERE event_id = ?1",
                    [&event.event_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                if existing != json {
                    return Err(StoreError::EventIdConflict(event.event_id.clone()));
                }
                continue;
            }
            tx.execute("INSERT INTO events(event_id, run_id, event_type, schema_version, occurred_at_ms, event_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![event.event_id, event.run_id, event.kind.name(), EVENT_SCHEMA_VERSION, sqlite_time(event.occurred_at_ms)?, json])?;
            inserted += 1;
        }
        if inserted > 0 {
            let history = read_events(&tx, run_id)?;
            let projection = replay(&history)
                .map_err(StoreError::InvalidHistory)?
                .ok_or_else(|| StoreError::InvalidHistory("run has no start event".into()))?;
            materialize(&tx, &projection)?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// Reads the materialized current state of one run.
    pub fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, StoreError> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT projection_json FROM runs WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value).map_err(StoreError::from))
            .transpose()
    }

    /// Reads a run's events in append order.
    pub fn load_events(&self, run_id: &str) -> Result<Vec<Event>, StoreError> {
        read_events(&self.connection, run_id)
    }

    /// Replays one run directly from its authoritative events.
    pub fn replay_run(&self, run_id: &str) -> Result<Option<RunProjection>, StoreError> {
        replay(&self.load_events(run_id)?).map_err(StoreError::InvalidHistory)
    }

    /// Rebuilds every projection from the log in one transaction.
    pub fn rebuild_all(&mut self) -> Result<(), StoreError> {
        let run_ids = {
            let mut statement = self
                .connection
                .prepare("SELECT DISTINCT run_id FROM events ORDER BY run_id")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM runs", [])?;
        for run_id in run_ids {
            let history = read_events(&tx, &run_id)?;
            let projection = replay(&history)
                .map_err(StoreError::InvalidHistory)?
                .ok_or_else(|| StoreError::InvalidHistory("run has no start event".into()))?;
            materialize(&tx, &projection)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Emits explicit interruption events for attempts still running after a
    /// restart. Repeated recovery is idempotent.
    pub fn recover_interrupted(&mut self) -> Result<usize, StoreError> {
        let pending = {
            let mut statement = self.connection.prepare("SELECT run_id, attempt_id, started_at_ms FROM attempts WHERE outcome IS NULL ORDER BY run_id, attempt_id")?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let now = u64::try_from(now).map_err(|_| StoreError::TimestampOverflow)?;
        let mut by_run: BTreeMap<String, Vec<Event>> = BTreeMap::new();
        for (run_id, attempt_id, started) in pending {
            let started = u64::try_from(started).map_err(|_| StoreError::TimestampOverflow)?;
            by_run.entry(run_id.clone()).or_default().push(Event {
                event_id: format!("xper:recovery:{attempt_id}"),
                run_id,
                occurred_at_ms: now.max(started),
                kind: EventKind::AttemptFinished {
                    attempt_id,
                    outcome: WorkOutcome::Interrupted,
                },
            });
        }
        let mut total = 0;
        for events in by_run.values() {
            total += self.append_boundary(events)?;
        }
        Ok(total)
    }

    /// Returns the latest applied migration number.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        let tx = self.connection.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")?;
        let version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if version > MIGRATIONS.last().map_or(0, |migration| migration.0) {
            return Err(StoreError::UnsupportedSchema(version));
        }
        for (number, sql) in MIGRATIONS {
            if *number > version {
                tx.execute_batch(sql)?;
                tx.execute(
                    "INSERT INTO schema_migrations(version) VALUES (?1)",
                    [number],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

impl EventStore for SqliteEventStore {
    type Error = StoreError;

    fn append_boundary(&mut self, events: &[Event]) -> Result<usize, Self::Error> {
        SqliteEventStore::append_boundary(self, events)
    }

    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error> {
        SqliteEventStore::load_run(self, run_id)
    }

    fn load_events(&self, run_id: &str) -> Result<Vec<Event>, Self::Error> {
        SqliteEventStore::load_events(self, run_id)
    }

    fn replay_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error> {
        SqliteEventStore::replay_run(self, run_id)
    }
}

fn sqlite_time(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::TimestampOverflow)
}

fn read_events(connection: &Connection, run_id: &str) -> Result<Vec<Event>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT schema_version, event_json FROM events WHERE run_id = ?1 ORDER BY sequence",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (version, json) = row?;
        if version != i64::from(EVENT_SCHEMA_VERSION) {
            return Err(StoreError::UnsupportedSchema(version));
        }
        events.push(serde_json::from_str(&json)?);
    }
    Ok(events)
}

fn materialize(tx: &Transaction<'_>, run: &RunProjection) -> Result<(), StoreError> {
    tx.execute("DELETE FROM runs WHERE run_id = ?1", [&run.run_id])?;
    let state = serde_json::to_value(run.status)?
        .as_str()
        .unwrap_or("unknown")
        .to_owned();
    let current_visit_id = run
        .visits
        .last()
        .filter(|visit| visit.exited_at_ms.is_none())
        .map(|visit| visit.visit_id.as_str());
    tx.execute("INSERT INTO runs(run_id, state, adapter, adapter_version, capabilities_json, current_visit_id, projection_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![run.run_id, state, run.metadata.adapter, run.metadata.version,
            serde_json::to_string(&run.metadata.capabilities)?, current_visit_id, serde_json::to_string(run)?])?;
    for visit in &run.visits {
        tx.execute("INSERT INTO phase_visits(visit_id, run_id, phase, visit_number, entered_at_ms, exited_at_ms, exit_gate_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![visit.visit_id, run.run_id, visit.phase, visit.visit_number,
                sqlite_time(visit.entered_at_ms)?, visit.exited_at_ms.map(sqlite_time).transpose()?, visit.exit_gate_id])?;
    }
    for assignment in run.assignments.values() {
        tx.execute("INSERT INTO assignments(assignment_id, run_id, visit_id, role, outcome) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![assignment.assignment_id, run.run_id, assignment.visit_id, assignment.role, outcome_name(assignment.outcome)])?;
    }
    for attempt in run.attempts.values() {
        tx.execute("INSERT INTO attempts(attempt_id, run_id, assignment_id, started_at_ms, finished_at_ms, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![attempt.attempt_id, run.run_id, attempt.assignment_id, sqlite_time(attempt.started_at_ms)?,
                attempt.finished_at_ms.map(sqlite_time).transpose()?, outcome_name(attempt.outcome)])?;
    }
    Ok(())
}

fn outcome_name(outcome: Option<WorkOutcome>) -> Option<&'static str> {
    outcome.map(|value| match value {
        WorkOutcome::Succeeded => "succeeded",
        WorkOutcome::Failed => "failed",
        WorkOutcome::Cancelled => "cancelled",
        WorkOutcome::TimedOut => "timed_out",
        WorkOutcome::Interrupted => "interrupted",
    })
}
