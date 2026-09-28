//! Passive SQLite recording with atomic delivery, session ownership, and replay.
//!
//! Legacy workflow history remains queryable. Opening a database never invents
//! interruption, failure, transition, or other execution events.

use std::{
    error::Error as StdError,
    fmt,
    path::Path,
    time::{Duration, Instant},
};

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use xper_application::{
    events::RecordedEvent,
    ports::{RunReader, RunRepository},
    read_models::{RunProjection, replay},
    use_cases::append_events::validate_batch,
};

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_initial.sql")),
    (2, include_str!("../migrations/0002_concurrency.sql")),
    (3, include_str!("../migrations/0003_session_isolation.sql")),
    (4, include_str!("../migrations/0004_passive_recordings.sql")),
];

/// Persistence mode, surfaced separately from the reported execution outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Durability {
    /// Events survive process exit.
    Persistent,
    /// Events exist only in the current process.
    Volatile,
}

impl Durability {
    /// Stable transport value for durability diagnostics.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Persistent => "persistent",
            Self::Volatile => "volatile",
        }
    }
}

/// Failure of an atomic recording operation or history query.
#[derive(Debug)]
pub enum StoreError {
    /// SQLite rejected an operation.
    Sqlite(rusqlite::Error),
    /// Stored JSON cannot be decoded.
    Json(serde_json::Error),
    /// The recording envelope or batch identity is invalid.
    InvalidInput(&'static str),
    /// An event ID was reused with different content.
    EventIdConflict(String),
    /// A different session owns the requested run.
    SessionConflict(String),
    /// An old workflow recording cannot receive new-format events.
    LegacyReadOnly(String),
    /// The database contains a newer schema version.
    UnsupportedSchema(i64),
    /// A legacy row does not contain an object payload.
    InvalidHistory(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
            Self::InvalidInput(message) => f.write_str(message),
            Self::EventIdConflict(id) => write!(f, "event ID has conflicting content: {id}"),
            Self::SessionConflict(id) => write!(f, "run belongs to another session: {id}"),
            Self::LegacyReadOnly(id) => write!(f, "legacy run is read-only: {id}"),
            Self::UnsupportedSchema(version) => write!(f, "unsupported database schema: {version}"),
            Self::InvalidHistory(message) => f.write_str(message),
        }
    }
}

impl StdError for StoreError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

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

/// Serialized atomic writes of adapter facts, without coordinator leases.
pub struct SqliteEventStore {
    connection: Connection,
    durability: Durability,
    degraded_reason: Option<String>,
}

impl SqliteEventStore {
    /// Opens and migrates a persistent recording database without creating facts.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        // Two fresh bridge processes can race while enabling WAL initially.
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
        };
        store.migrate()?;
        store.rebuild_all()?;
        Ok(store)
    }

    /// Inspects either recording format without migrating or writing anything.
    pub fn inspect(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        check_version(&connection)?;
        Ok(Self {
            connection,
            durability: Durability::Persistent,
            degraded_reason: None,
        })
    }

    /// Opens isolated ephemeral storage, without changing execution semantics.
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

    /// Uses ephemeral storage only when SQLite cannot open the configured path.
    /// Corrupt data, incompatible schemas, and rejected writes are not hidden.
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

    /// Reports whether acknowledged events survive process exit.
    #[must_use]
    pub const fn durability(&self) -> Durability {
        self.durability
    }

    /// Explains why the persistent store was unavailable, if fallback occurred.
    #[must_use]
    pub fn degraded_reason(&self) -> Option<&str> {
        self.degraded_reason.as_deref()
    }

    /// Records one complete delivery and returns the number of new events.
    pub fn append_events(
        &mut self,
        session_id: &str,
        events: &[RecordedEvent],
    ) -> Result<usize, StoreError> {
        validate_batch(session_id, events).map_err(StoreError::InvalidInput)?;
        let run_id = &events[0].run_id;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let legacy: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE run_id = ?1)",
            [run_id],
            |row| row.get(0),
        )?;
        if legacy {
            return Err(StoreError::LegacyReadOnly(run_id.clone()));
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT session_id FROM recording_runs WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.as_deref().is_some_and(|owner| owner != session_id) {
            return Err(StoreError::SessionConflict(run_id.clone()));
        }
        tx.execute(
            "INSERT OR IGNORE INTO recording_runs(run_id, session_id) VALUES (?1, ?2)",
            params![run_id, session_id],
        )?;
        let mut accepted = 0;
        for event in events {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT event_json FROM recorded_events WHERE event_id = ?1",
                    [&event.event_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                if serde_json::from_str::<RecordedEvent>(&existing)? != *event {
                    return Err(StoreError::EventIdConflict(event.event_id.clone()));
                }
                continue;
            }
            let legacy_id: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE event_id = ?1)",
                [&event.event_id],
                |row| row.get(0),
            )?;
            if legacy_id {
                return Err(StoreError::EventIdConflict(event.event_id.clone()));
            }
            tx.execute(
                "INSERT INTO recorded_events(event_id, run_id, event_type, occurred_at_ms, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    event.event_id,
                    event.run_id,
                    event.event_type,
                    event.occurred_at as i64,
                    serde_json::to_string(event)?,
                ],
            )?;
            accepted += 1;
        }
        tx.execute(
            "UPDATE recording_runs SET created_sequence = (SELECT MIN(sequence) FROM recorded_events WHERE run_id = ?1) WHERE run_id = ?1 AND created_sequence = 0",
            [run_id],
        )?;
        materialize(&tx, run_id, session_id)?;
        tx.commit()?;
        Ok(accepted)
    }

    /// Reads the latest run created by the requested session, including legacy history.
    pub fn session_run(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        if table_exists(&self.connection, "recording_runs")? {
            let run: Option<String> = self.connection.query_row(
                "SELECT run_id FROM recording_runs WHERE session_id = ?1 ORDER BY created_sequence DESC LIMIT 1",
                [session_id], |row| row.get(0),
            ).optional()?;
            if run.is_some() {
                return Ok(run);
            }
        }
        if table_exists(&self.connection, "session_runs")? {
            return Ok(self
                .connection
                .query_row(
                    "SELECT run_id FROM session_runs WHERE session_key = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .optional()?);
        }
        Ok(None)
    }

    /// Reads a rebuildable generic projection or an explicitly marked legacy recording.
    pub fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, StoreError> {
        if table_exists(&self.connection, "recording_runs")? {
            let owner: Option<String> = self
                .connection
                .query_row(
                    "SELECT session_id FROM recording_runs WHERE run_id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner {
                return Ok(replay(
                    &owner,
                    &read_recorded_events(&self.connection, run_id)?,
                ));
            }
        }
        let events = read_legacy_events(&self.connection, run_id)?;
        if events.is_empty() {
            return Ok(None);
        }
        let session_id: Option<String> =
            if table_exists(&self.connection, "session_runs")? {
                self.connection.query_row(
                "SELECT session_key FROM session_runs WHERE run_id = ?1 ORDER BY rowid LIMIT 1",
                [run_id], |row| row.get(0),
            ).optional()?
            } else {
                None
            };
        let mut run = replay(session_id.as_deref().unwrap_or_default(), &events);
        if let Some(run) = &mut run {
            run.status = "legacy".into();
        }
        Ok(run)
    }

    /// Reads observations in append order, preserving arbitrary adapter payloads.
    pub fn load_events(&self, run_id: &str) -> Result<Vec<RecordedEvent>, StoreError> {
        if table_exists(&self.connection, "recorded_events")? {
            let events = read_recorded_events(&self.connection, run_id)?;
            if !events.is_empty() {
                return Ok(events);
            }
        }
        read_legacy_events(&self.connection, run_id)
    }

    /// Reads the latest newly recorded run, falling back to legacy recordings.
    pub fn latest_run(&self) -> Result<Option<RunProjection>, StoreError> {
        if table_exists(&self.connection, "recording_runs")? {
            let run_id: Option<String> = self
                .connection
                .query_row(
                    "SELECT run_id FROM recording_runs ORDER BY created_sequence DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(run_id) = run_id {
                return self.load_run(&run_id);
            }
        }
        let run_id: Option<String> = self
            .connection
            .query_row(
                "SELECT run_id FROM events GROUP BY run_id ORDER BY MIN(sequence) DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        run_id
            .map(|id| self.load_run(&id))
            .transpose()
            .map(Option::flatten)
    }

    /// Replays the authoritative log, without relying on a stored projection.
    pub fn replay_run(&self, run_id: &str) -> Result<Option<RunProjection>, StoreError> {
        self.load_run(run_id)
    }

    /// Rebuilds only the generic recording projections, never legacy workflow state.
    pub fn rebuild_all(&mut self) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let runs = {
            let mut statement = tx.prepare("SELECT run_id, session_id FROM recording_runs")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (run_id, session_id) in runs {
            materialize(&tx, &run_id, &session_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")?;
        let version = check_version(&tx)?;
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

impl RunReader for SqliteEventStore {
    type Error = StoreError;

    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error> {
        Self::load_run(self, run_id)
    }

    fn load_events(&self, run_id: &str) -> Result<Vec<RecordedEvent>, Self::Error> {
        Self::load_events(self, run_id)
    }

    fn latest_run(&self) -> Result<Option<RunProjection>, Self::Error> {
        Self::latest_run(self)
    }

    fn session_run(&self, session_id: &str) -> Result<Option<String>, Self::Error> {
        Self::session_run(self, session_id)
    }
}

impl RunRepository for SqliteEventStore {
    fn invalid_input_message(error: &Self::Error) -> Option<&'static str> {
        match error {
            StoreError::InvalidInput(message) => Some(message),
            StoreError::EventIdConflict(_) => Some("event ID has conflicting content"),
            StoreError::SessionConflict(_) => Some("run belongs to another session"),
            StoreError::LegacyReadOnly(_) => Some("legacy run is read-only"),
            _ => None,
        }
    }

    fn append_events(
        &mut self,
        session_id: &str,
        events: &[RecordedEvent],
    ) -> Result<usize, Self::Error> {
        Self::append_events(self, session_id, events)
    }
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )?)
}

fn check_version(connection: &Connection) -> Result<i64, StoreError> {
    let version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if version > MIGRATIONS.last().map_or(0, |(version, _)| *version) {
        return Err(StoreError::UnsupportedSchema(version));
    }
    Ok(version)
}

fn read_recorded_events(
    connection: &Connection,
    run_id: &str,
) -> Result<Vec<RecordedEvent>, StoreError> {
    let mut statement = connection
        .prepare("SELECT event_json FROM recorded_events WHERE run_id = ?1 ORDER BY sequence")?;
    let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        let event: RecordedEvent = serde_json::from_str(&row?)?;
        event
            .validate()
            .map_err(|message| StoreError::InvalidHistory(message.into()))?;
        Ok(event)
    })
    .collect()
}

fn read_legacy_events(
    connection: &Connection,
    run_id: &str,
) -> Result<Vec<RecordedEvent>, StoreError> {
    let mut statement = connection.prepare("SELECT event_id, event_type, occurred_at_ms, event_json FROM events WHERE run_id = ?1 ORDER BY sequence")?;
    let rows = statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    rows.map(|row| {
        let (event_id, event_type, occurred_at, original) = row?;
        let Value::Object(data) = serde_json::from_str(&original)? else {
            return Err(StoreError::InvalidHistory(
                "legacy event payload must be an object".into(),
            ));
        };
        Ok(RecordedEvent {
            schema_version: 1,
            event_id,
            run_id: run_id.into(),
            occurred_at: u64::try_from(occurred_at)
                .map_err(|_| StoreError::InvalidHistory("negative legacy timestamp".into()))?,
            event_type: format!("legacy.{event_type}"),
            data,
        })
    })
    .collect()
}

fn materialize(connection: &Connection, run_id: &str, session_id: &str) -> Result<(), StoreError> {
    let events = read_recorded_events(connection, run_id)?;
    let run = replay(session_id, &events);
    connection.execute(
        "UPDATE recording_runs SET projection_json = ?2 WHERE run_id = ?1",
        params![run_id, serde_json::to_string(&run)?],
    )?;
    Ok(())
}
