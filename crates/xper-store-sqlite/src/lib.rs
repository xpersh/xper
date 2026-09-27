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
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use xper_application::events::{EVENT_SCHEMA_VERSION, Event, EventKind, WorkOutcome};
use xper_application::ports::{RunReader, RunRepository};
use xper_application::read_models::{RunProjection, replay};

/// Stable package identity used by workspace dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_initial.sql")),
    (2, include_str!("../migrations/0002_concurrency.sql")),
    (3, include_str!("../migrations/0003_session_isolation.sql")),
];
const LEASE_MS: i64 = 30_000;
static NEXT_COORDINATOR: AtomicU64 = AtomicU64::new(0);

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

/// A SQLite adapter with serialized writes and per-coordinator attempt ownership.
pub struct SqliteEventStore {
    connection: Connection,
    durability: Durability,
    degraded_reason: Option<String>,
    coordinator_id: Option<String>,
}

impl SqliteEventStore {
    /// Opens a persistent database and recovers only attempts with inactive owners.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        // Two new bridge processes can race while first switching a fresh DB to WAL.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match connection.pragma_update(None, "journal_mode", "WAL") {
                Ok(()) => break,
                Err(rusqlite::Error::SqliteFailure(failure, _))
                    if matches!(
                        failure.code,
                        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                    ) && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error.into()),
            }
        }
        let mut store = Self {
            connection,
            durability: Durability::Persistent,
            degraded_reason: None,
            coordinator_id: Some(fresh_coordinator_id()),
        };
        store.migrate()?;
        store.rebuild_all()?;
        store.heartbeat()?;
        Ok(store)
    }

    /// Opens an existing database without rebuilding or recovering active attempts.
    pub fn inspect(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        Ok(Self {
            connection,
            durability: Durability::Persistent,
            degraded_reason: None,
            coordinator_id: None,
        })
    }

    /// Opens a memory-backed store for tests or explicit ephemeral use.
    pub fn in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self {
            connection,
            durability: Durability::Volatile,
            degraded_reason: None,
            coordinator_id: Some(fresh_coordinator_id()),
        };
        store.migrate()?;
        store.heartbeat()?;
        Ok(store)
    }

    /// Continues in memory if the configured database cannot be opened.
    /// Callers can surface `degraded_reason` as a warning.
    pub fn open_or_volatile(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        match Self::open(path) {
            Ok(store) => Ok(store),
            Err(error) => match &error {
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(failure, _))
                    if failure.code == ErrorCode::CannotOpen =>
                {
                    let mut store = Self::in_memory()?;
                    store.degraded_reason = Some(error.to_string());
                    Ok(store)
                }
                _ => Err(error),
            },
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

    /// Renews this bridge's ownership lease and recovers newly expired attempts.
    pub fn heartbeat(&mut self) -> Result<(), StoreError> {
        let Some(id) = self.coordinator_id.as_deref() else {
            return Ok(());
        };
        let expires = now_ms()?
            .checked_add(LEASE_MS)
            .ok_or(StoreError::TimestampOverflow)?;
        self.connection.execute(
            "INSERT INTO coordinator_leases(coordinator_id, expires_at_ms) VALUES (?1, ?2) ON CONFLICT(coordinator_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms",
            params![id, expires],
        )?;
        self.recover_interrupted()?;
        Ok(())
    }

    /// Returns the run last bound to one adapter session.
    pub fn session_run(&self, session_key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT run_id FROM session_runs WHERE session_key = ?1",
                [session_key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Applies an entire domain boundary atomically. Duplicate identical
    /// event IDs have no effect; conflicting reuse aborts the whole boundary.
    pub fn append_boundary(&mut self, events: &[Event]) -> Result<usize, StoreError> {
        self.append_with_session(events, None)
    }

    /// Starts a run and binds its adapter session in the same transaction.
    pub fn append_boundary_and_bind_session(
        &mut self,
        events: &[Event],
        session_key: &str,
        run_id: &str,
    ) -> Result<usize, StoreError> {
        self.append_with_session(events, Some((session_key, run_id)))
    }

    fn append_with_session(
        &mut self,
        events: &[Event],
        session: Option<(&str, &str)>,
    ) -> Result<usize, StoreError> {
        if events.is_empty() {
            return Ok(0);
        }
        let run_id = &events[0].run_id;
        if events.iter().any(|e| e.run_id != *run_id) {
            return Err(StoreError::InvalidHistory(
                "boundary spans multiple runs".into(),
            ));
        }
        if session.is_some_and(|(_, bound_run_id)| bound_run_id != run_id) {
            return Err(StoreError::InvalidHistory(
                "session binding has a different run ID".into(),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = append_boundary_in_tx(&tx, events, self.coordinator_id.as_deref(), false)?;
        if let Some((session_key, run_id)) = session {
            tx.execute(
                "INSERT INTO session_runs(session_key, run_id) VALUES (?1, ?2) ON CONFLICT(session_key) DO UPDATE SET run_id = excluded.run_id",
                params![session_key, run_id],
            )?;
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

    /// Returns the most recently started run in this workspace database.
    pub fn latest_run(&self) -> Result<Option<RunProjection>, StoreError> {
        let run_id: Option<String> = self.connection.query_row(
            "SELECT run_id FROM events WHERE event_type = 'run.started' ORDER BY sequence DESC LIMIT 1",
            [],
            |row| row.get(0),
        ).optional()?;
        run_id
            .map(|id| self.load_run(&id))
            .transpose()
            .map(Option::flatten)
    }

    /// Replays one run directly from its authoritative events.
    pub fn replay_run(&self, run_id: &str) -> Result<Option<RunProjection>, StoreError> {
        replay(&self.load_events(run_id)?).map_err(StoreError::InvalidHistory)
    }

    /// Rebuilds every projection from the log in one transaction.
    pub fn rebuild_all(&mut self) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run_ids = {
            let mut statement = tx.prepare("SELECT DISTINCT run_id FROM events ORDER BY run_id")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
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

    /// Emits interruption events only for attempts without a live owner.
    pub fn recover_interrupted(&mut self) -> Result<usize, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms()?;
        let pending = {
            let mut statement = tx.prepare("SELECT a.run_id, a.attempt_id, a.started_at_ms FROM attempts a LEFT JOIN active_attempt_owners o ON o.attempt_id = a.attempt_id LEFT JOIN coordinator_leases l ON l.coordinator_id = o.coordinator_id WHERE a.outcome IS NULL AND (o.attempt_id IS NULL OR l.expires_at_ms IS NULL OR l.expires_at_ms <= ?1) ORDER BY a.run_id, a.attempt_id")?;
            statement
                .query_map([now], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut by_run: BTreeMap<String, Vec<Event>> = BTreeMap::new();
        for (run_id, attempt_id, started) in pending {
            by_run.entry(run_id.clone()).or_default().push(Event {
                event_id: format!("xper:recovery:{attempt_id}"),
                run_id,
                occurred_at_ms: u64::try_from(now.max(started))
                    .map_err(|_| StoreError::TimestampOverflow)?,
                kind: EventKind::AttemptFinished {
                    attempt_id,
                    outcome: WorkOutcome::Interrupted,
                },
            });
        }
        let mut total = 0;
        for events in by_run.values() {
            total += append_boundary_in_tx(&tx, events, None, true)?;
        }
        tx.commit()?;
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
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
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

impl Drop for SqliteEventStore {
    fn drop(&mut self) {
        if let Some(id) = self.coordinator_id.as_deref() {
            let _ = self.connection.execute(
                "DELETE FROM coordinator_leases WHERE coordinator_id = ?1",
                [id],
            );
        }
    }
}

fn fresh_coordinator_id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_COORDINATOR.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> Result<i64, StoreError> {
    sqlite_time(
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .map_err(|_| StoreError::TimestampOverflow)?,
    )
}

fn append_boundary_in_tx(
    tx: &Transaction<'_>,
    events: &[Event],
    coordinator_id: Option<&str>,
    recovery: bool,
) -> Result<usize, StoreError> {
    let run_id = &events[0].run_id;
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
        match &event.kind {
            EventKind::AttemptStarted {
                attempt_id,
                assignment_id,
                ..
            } => {
                let owner = coordinator_id.ok_or_else(|| {
                    StoreError::InvalidHistory("attempt start requires a coordinator".into())
                })?;
                tx.execute(
                    "INSERT INTO active_attempt_owners(attempt_id, assignment_id, coordinator_id) VALUES (?1, ?2, ?3)",
                    params![attempt_id, assignment_id, owner],
                )?;
            }
            EventKind::AttemptFinished { attempt_id, .. } => {
                if !recovery {
                    let owner: Option<String> = tx.query_row(
                        "SELECT coordinator_id FROM active_attempt_owners WHERE attempt_id = ?1",
                        [attempt_id], |row| row.get(0)
                    ).optional()?;
                    if owner.as_deref() != coordinator_id {
                        return Err(StoreError::InvalidHistory(
                            "attempt belongs to another coordinator or was interrupted".into(),
                        ));
                    }
                }
                tx.execute(
                    "DELETE FROM active_attempt_owners WHERE attempt_id = ?1",
                    [attempt_id],
                )?;
            }
            _ => {}
        }
        tx.execute("INSERT INTO events(event_id, run_id, event_type, schema_version, occurred_at_ms, event_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![event.event_id, event.run_id, event.kind.name(), EVENT_SCHEMA_VERSION, sqlite_time(event.occurred_at_ms)?, json])?;
        inserted += 1;
    }
    if inserted > 0 {
        let history = read_events(tx, run_id)?;
        let projection = replay(&history)
            .map_err(StoreError::InvalidHistory)?
            .ok_or_else(|| StoreError::InvalidHistory("run has no start event".into()))?;
        materialize(tx, &projection)?;
    }
    Ok(inserted)
}

impl RunReader for SqliteEventStore {
    type Error = StoreError;

    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error> {
        SqliteEventStore::load_run(self, run_id)
    }

    fn load_events(&self, run_id: &str) -> Result<Vec<Event>, Self::Error> {
        SqliteEventStore::load_events(self, run_id)
    }

    fn latest_run(&self) -> Result<Option<RunProjection>, Self::Error> {
        SqliteEventStore::latest_run(self)
    }

    fn session_run(&self, session_id: &str) -> Result<Option<String>, Self::Error> {
        SqliteEventStore::session_run(self, session_id)
    }
}

impl RunRepository for SqliteEventStore {
    fn append_boundary(&mut self, events: &[Event]) -> Result<usize, Self::Error> {
        SqliteEventStore::append_boundary(self, events)
    }

    fn append_boundary_and_bind_session(
        &mut self,
        events: &[Event],
        session_id: &str,
        run_id: &str,
    ) -> Result<usize, Self::Error> {
        SqliteEventStore::append_boundary_and_bind_session(self, events, session_id, run_id)
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
