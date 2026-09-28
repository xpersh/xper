//! Atomic passive delivery, concurrent sessions, and read-only legacy history.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
};

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use xper_application::{ApplicationError, events::RecordedEvent, use_cases::append_events};
use xper_store_sqlite::{Durability, SqliteEventStore, StoreError};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xper-recording-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn database(&self) -> PathBuf {
        self.0.join("events.sqlite")
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn event(id: &str, kind: &str, data: Value) -> RecordedEvent {
    RecordedEvent {
        schema_version: 1,
        event_id: id.into(),
        run_id: "run".into(),
        occurred_at: 100,
        event_type: kind.into(),
        data: data.as_object().unwrap().clone(),
    }
}

#[test]
fn accepts_arbitrary_transitions_and_checkpoints_without_creating_workflow_facts() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let events = [
        event("1", "run.started", json!({})),
        event("2", "phase.entered", json!({"phase":"future-stage"})),
        event("3", "phase.entered", json!({"phase":"initial-stage"})),
        event(
            "4",
            "attempt.finished",
            json!({"attemptId":"unknown-attempt","outcome":"custom verdict"}),
        ),
        event(
            "5",
            "adapter.state",
            json!({"state":{"phase":"private","arbitrary":[3,true]}}),
        ),
    ];
    assert_eq!(store.append_events("session", &events).unwrap(), 5);
    assert_eq!(store.load_events("run").unwrap(), events);
    let run = store.load_run("run").unwrap().unwrap();
    assert_eq!(run.phase.as_deref(), Some("initial-stage"));
    assert_eq!(run.metrics.attempts_started, 0);
    assert_eq!(run.metrics.attempts_finished, 1);
    assert_eq!(run.metrics.cost_micros, None);
}

#[test]
fn exact_duplicate_deliveries_are_idempotent_including_duplicates_inside_a_batch() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let first = event("1", "custom.fact", json!({"unchanged":true}));
    assert_eq!(
        store
            .append_events("session", &[first.clone(), first.clone()])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .append_events("session", std::slice::from_ref(&first))
            .unwrap(),
        0
    );
    assert_eq!(store.load_events("run").unwrap(), [first]);
    assert_eq!(
        store.load_run("run").unwrap().unwrap().metrics.event_count,
        1
    );
}

#[test]
fn conflicting_event_ids_rollback_every_new_event_and_binding_in_the_batch() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let first = event("1", "custom.fact", json!({"value":1}));
    store
        .append_events("session", std::slice::from_ref(&first))
        .unwrap();
    let second = event("2", "custom.fact", json!({"value":2}));
    let conflict = event("1", "custom.fact", json!({"value":3}));
    assert!(matches!(
        store.append_events("session", &[second, conflict]),
        Err(StoreError::EventIdConflict(_))
    ));
    assert_eq!(store.load_events("run").unwrap(), [first]);

    let mut new = event("fresh", "new.fact", json!({}));
    new.run_id = "new-run".into();
    let mut conflict = event("1", "custom.fact", json!({"value":1}));
    conflict.run_id = "new-run".into();
    assert!(
        store
            .append_events("new-session", &[new, conflict])
            .is_err()
    );
    assert!(store.load_run("new-run").unwrap().is_none());
    assert!(store.session_run("new-session").unwrap().is_none());
}

#[test]
fn session_ownership_is_enforced_even_for_identical_event_redelivery() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let events = [event("e", "run.started", json!({}))];
    store.append_events("owner", &events).unwrap();
    let result = append_events::execute(
        &mut store,
        append_events::Request {
            session_id: "foreign",
            events: &events,
        },
    );
    assert!(matches!(
        result,
        Err(ApplicationError::InvalidInput(
            "run belongs to another session"
        ))
    ));
    assert_eq!(store.session_run("owner").unwrap().as_deref(), Some("run"));
    assert_eq!(store.session_run("foreign").unwrap(), None);
    assert_eq!(store.load_events("run").unwrap(), events);
}

#[test]
fn one_session_can_record_multiple_runs_without_changing_prior_ownership() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    store
        .append_events("owner", &[event("a", "custom", json!({}))])
        .unwrap();
    let mut next = event("b", "custom", json!({}));
    next.run_id = "next".into();
    store.append_events("owner", &[next]).unwrap();
    assert_eq!(store.session_run("owner").unwrap().as_deref(), Some("next"));
    assert_eq!(
        store
            .load_run("run")
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("owner")
    );
    assert_eq!(store.latest_run().unwrap().unwrap().run_id, "next");
}

#[test]
fn invalid_batch_shape_is_rejected_even_when_calling_the_store_directly() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let mut invalid = event("e", "anything", json!({}));
    invalid.schema_version = 2;
    assert!(matches!(
        store.append_events("s", &[invalid]),
        Err(StoreError::InvalidInput(_))
    ));
    let first = event("first", "anything", json!({}));
    let mut other = event("second", "anything", json!({}));
    other.run_id = "other".into();
    assert!(store.append_events("s", &[first, other]).is_err());
    assert!(store.append_events("s", &[]).is_err());
    assert!(store.latest_run().unwrap().is_none());
}

#[test]
fn reopen_and_rebuild_preserve_the_same_projection_and_never_finish_open_attempts() {
    let directory = Directory::new();
    let path = directory.database();
    let events = [
        event("1", "run.started", json!({})),
        event("2", "attempt.started", json!({"attemptId":"open-attempt"})),
        event(
            "3",
            "model.usage",
            json!({"inputTokens":19,"outputTokens":4,"costMicros":23}),
        ),
        event(
            "4",
            "adapter.state",
            json!({"state":{"pending":"owned by adapter"}}),
        ),
    ];
    let projection = {
        let mut store = SqliteEventStore::open(&path).unwrap();
        assert_eq!(store.durability(), Durability::Persistent);
        store.append_events("session", &events).unwrap();
        store.load_run("run").unwrap()
    };
    let mut reopened = SqliteEventStore::open(&path).unwrap();
    reopened.rebuild_all().unwrap();
    assert_eq!(reopened.load_run("run").unwrap(), projection);
    assert_eq!(reopened.replay_run("run").unwrap(), projection);
    assert_eq!(reopened.load_events("run").unwrap(), events);
    let read_only = SqliteEventStore::inspect(&path).unwrap();
    assert_eq!(read_only.load_run("run").unwrap(), projection);
    assert_eq!(projection.unwrap().metrics.attempts_finished, 0);
}

#[test]
fn sqlite_failure_rolls_back_events_projection_and_new_session_binding() {
    let directory = Directory::new();
    let path = directory.database();
    let mut store = SqliteEventStore::open(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_test_event BEFORE INSERT ON recorded_events WHEN NEW.event_type = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    let events = [
        event("1", "accepted", json!({})),
        event("2", "reject", json!({})),
    ];
    assert!(matches!(
        store.append_events("owner", &events),
        Err(StoreError::Sqlite(_))
    ));
    assert!(store.load_events("run").unwrap().is_empty());
    assert!(store.load_run("run").unwrap().is_none());
    assert!(store.session_run("owner").unwrap().is_none());
}

#[test]
fn simultaneous_fresh_open_and_ownership_claims_keep_one_atomic_winner() {
    let directory = Directory::new();
    let path = directory.database();
    let barrier = Arc::new(Barrier::new(2));
    let workers = ["first", "second"].map(|session| {
        let path = path.clone();
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            let mut store = SqliteEventStore::open(path).unwrap();
            store.append_events(session, &[event(session, "run.started", json!({}))])
        })
    });
    let results = workers.map(|worker| worker.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(StoreError::SessionConflict(_))))
            .count(),
        1
    );
    assert_eq!(
        SqliteEventStore::inspect(path)
            .unwrap()
            .load_events("run")
            .unwrap()
            .len(),
        1
    );
}

fn create_legacy_database(path: &Path) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    for migration in [
        include_str!("../migrations/0001_initial.sql"),
        include_str!("../migrations/0002_concurrency.sql"),
        include_str!("../migrations/0003_session_isolation.sql"),
    ] {
        connection.execute_batch(migration).unwrap();
    }
    connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(1), (2), (3); INSERT INTO session_runs(session_key,run_id) VALUES('legacy-session','legacy-run');").unwrap();
    let facts = [
        (
            "start",
            "run.started",
            json!({"type":"run_started","metadata":{"adapter":"test","version":"old","capabilities":{}}}),
        ),
        (
            "phase",
            "phase.entered",
            json!({"type":"phase_entered","phase":"unrecognized by old replay","visit_id":"visit","visit_number":1}),
        ),
        (
            "attempt",
            "attempt.started",
            json!({"type":"attempt_started","attempt_id":"unfinished","assignment_id":"missing"}),
        ),
    ];
    facts.into_iter().map(|(id, kind, data)| {
        let original = json!({"event_id":id,"run_id":"legacy-run","occurred_at_ms":50,"kind":data}).to_string();
        connection.execute("INSERT INTO events(event_id,run_id,event_type,schema_version,occurred_at_ms,event_json) VALUES(?1,'legacy-run',?2,1,50,?3)", params![id,kind,original]).unwrap();
        original
    }).collect()
}

#[test]
fn legacy_history_is_inspectable_without_old_workflow_validation_or_mutation() {
    let directory = Directory::new();
    let path = directory.database();
    let originals = create_legacy_database(&path);
    let before_migration = SqliteEventStore::inspect(&path).unwrap();
    let projection = before_migration.latest_run().unwrap().unwrap();
    assert_eq!(projection.status, "legacy");
    assert_eq!(projection.phase, None);
    assert_eq!(projection.session_id.as_deref(), Some("legacy-session"));
    let timeline = before_migration.load_events("legacy-run").unwrap();
    assert_eq!(timeline[0].event_type, "legacy.run.started");
    assert_eq!(
        timeline[0].data,
        serde_json::from_str::<Value>(&originals[0])
            .unwrap()
            .as_object()
            .unwrap()
            .clone()
    );
    drop(before_migration);
    let mut store = SqliteEventStore::open(&path).unwrap();
    store.rebuild_all().unwrap();
    assert_eq!(store.load_events("legacy-run").unwrap(), timeline);
    let mut attempted = event("new", "custom", json!({}));
    attempted.run_id = "legacy-run".into();
    assert!(matches!(
        store.append_events("legacy-session", &[attempted]),
        Err(StoreError::LegacyReadOnly(_))
    ));
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare("SELECT event_json FROM events ORDER BY sequence")
        .unwrap();
    let after = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(after, originals);
    assert_eq!(store.load_run("legacy-run").unwrap().unwrap(), projection);
}

#[test]
fn newer_schema_is_rejected_without_using_volatile_fallback() {
    let directory = Directory::new();
    let path = directory.database();
    create_legacy_database(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("INSERT INTO schema_migrations VALUES(99)", [])
        .unwrap();
    assert!(matches!(
        SqliteEventStore::open_or_volatile(&path),
        Err(StoreError::UnsupportedSchema(99))
    ));
    assert!(matches!(
        SqliteEventStore::inspect(&path),
        Err(StoreError::UnsupportedSchema(99))
    ));
}

#[test]
fn unavailable_path_uses_explicit_volatile_storage_without_fabricating_outcomes() {
    let directory = Directory::new();
    let mut store =
        SqliteEventStore::open_or_volatile(directory.0.join("missing").join("events.sqlite"))
            .unwrap();
    assert_eq!(store.durability(), Durability::Volatile);
    assert!(store.degraded_reason().is_some());
    let events = [event(
        "e",
        "attempt.started",
        json!({"attemptId":"still running"}),
    )];
    store.append_events("s", &events).unwrap();
    assert_eq!(store.load_events("run").unwrap(), events);
    assert_eq!(
        store
            .load_run("run")
            .unwrap()
            .unwrap()
            .metrics
            .attempts_finished,
        0
    );
}

#[test]
fn incompatible_recorded_envelopes_are_reported_instead_of_silently_replayed() {
    let directory = Directory::new();
    let path = directory.database();
    let mut store = SqliteEventStore::open(&path).unwrap();
    store
        .append_events("session", &[event("e", "vendor.fact", json!({}))])
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE recorded_events SET event_json = json_set(event_json, '$.schemaVersion', 2)",
            [],
        )
        .unwrap();
    assert!(matches!(
        store.load_run("run"),
        Err(StoreError::InvalidHistory(_))
    ));
    assert!(matches!(
        SqliteEventStore::open_or_volatile(&path),
        Err(StoreError::InvalidHistory(_))
    ));
}

#[test]
fn unbound_legacy_history_reports_unknown_session_as_null() {
    let directory = Directory::new();
    let path = directory.database();
    create_legacy_database(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute("DELETE FROM session_runs", []).unwrap();
    let store = SqliteEventStore::inspect(&path).unwrap();
    let run = store.load_run("legacy-run").unwrap().unwrap();
    assert_eq!(run.session_id, None);
    assert_eq!(serde_json::to_value(run).unwrap()["sessionId"], Value::Null);
}
