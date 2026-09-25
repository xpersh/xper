//! Acceptance tests for atomic replay, recovery, privacy, and fallback.

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use xper_application::events::{AdapterMetadata, Event, EventKind, RunStatus, WorkOutcome};
use xper_domain::{
    Clock, GateEvaluation, GateResult, IdGenerator, Identifier, Phase, Run, Timestamp,
    TransitionRequest,
};
use xper_store_sqlite::{Durability, SqliteEventStore, StoreError};

struct ClockAt(u64);
impl Clock for ClockAt {
    fn now(&mut self) -> Timestamp {
        Timestamp::from_millis(self.0)
    }
}
struct Ids(u64);
impl IdGenerator for Ids {
    fn next_id(&mut self) -> Identifier {
        self.0 += 1;
        Identifier::new(format!("id-{}", self.0)).unwrap()
    }
}
fn metadata() -> AdapterMetadata {
    AdapterMetadata {
        adapter: "test-adapter".into(),
        version: "1.2.3".into(),
        capabilities: BTreeMap::from([("subagents".into(), true)]),
    }
}
fn event(id: &str, run: &str, at: u64, kind: EventKind) -> Event {
    Event {
        event_id: id.into(),
        run_id: run.into(),
        occurred_at_ms: at,
        kind,
    }
}
fn started() -> Vec<Event> {
    vec![
        event(
            "e1",
            "r1",
            100,
            EventKind::RunStarted {
                metadata: metadata(),
            },
        ),
        event(
            "e2",
            "r1",
            100,
            EventKind::PhaseEntered {
                visit_id: "v1".into(),
                phase: "intake".into(),
                visit_number: 1,
            },
        ),
    ]
}
fn temp_db() -> (PathBuf, PathBuf) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("xper-store-{}-{stamp}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let db = dir.join("events.sqlite");
    (dir, db)
}

#[test]
fn domain_events_replay_to_the_same_run_phase_and_visits() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    let mut clock = ClockAt(100);
    let mut ids = Ids(0);
    let (mut run, start_events) =
        Run::start("PRIVATE PROMPT: do not persist", &mut clock, &mut ids).into_parts();
    let durable_start: Vec<_> = start_events
        .iter()
        .map(|e| Event::from_domain(e, &metadata()))
        .collect();
    assert_eq!(store.append_boundary(&durable_start).unwrap(), 2);
    assert!(
        !serde_json::to_string(&durable_start)
            .unwrap()
            .contains("PRIVATE PROMPT")
    );

    for (request, phase) in [
        ("to-discovery", Phase::Discovery),
        ("to-define", Phase::Define),
        ("revisit", Phase::Discovery),
    ] {
        clock.0 += 10;
        let transition = TransitionRequest::new(
            Identifier::new(request).unwrap().into(),
            phase,
            GateEvaluation::new("gate", GateResult::Passed, Vec::new()),
        );
        let receipt = run.transition(transition, &mut clock, &mut ids).unwrap();
        let events: Vec<_> = receipt
            .events()
            .iter()
            .map(|e| Event::from_domain(e, &metadata()))
            .collect();
        assert_eq!(store.append_boundary(&events).unwrap(), 4);
        assert_eq!(store.append_boundary(&events).unwrap(), 0);
    }
    let projected = store.load_run(run.id().as_str()).unwrap().unwrap();
    assert_eq!(
        projected,
        store.replay_run(run.id().as_str()).unwrap().unwrap()
    );
    assert_eq!(projected.status, RunStatus::Active);
    assert_eq!(projected.metadata, metadata());
    assert_eq!(projected.visits.len(), run.phase_visits().len());
    assert_eq!(projected.gates.len(), run.gates().len());
    for gate in run.gates() {
        let restored = &projected.gates[gate.id().as_str()];
        assert_eq!(restored.visit_id, gate.phase_visit_id().as_str());
        assert_eq!(restored.evaluated_at_ms, gate.evaluated_at().as_millis());
        assert!(restored.passed);
    }
    for (actual, expected) in projected.visits.iter().zip(run.phase_visits()) {
        assert_eq!(actual.visit_id, expected.id().as_str());
        assert_eq!(actual.visit_number, expected.visit_number());
        assert_eq!(actual.entered_at_ms, expected.entered_at().as_millis());
    }
    assert_eq!(projected.visits.last().unwrap().phase, "discovery");
    store.rebuild_all().unwrap();
    assert_eq!(store.load_run(run.id().as_str()).unwrap(), Some(projected));
}

#[test]
fn boundary_rolls_back_and_reopen_interrupts_unfinished_attempts() {
    let (dir, path) = temp_db();
    {
        let mut store = SqliteEventStore::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
        assert_eq!(store.append_boundary(&started()).unwrap(), 2);
        let work = [
            event(
                "e3",
                "r1",
                110,
                EventKind::AssignmentCreated {
                    assignment_id: "a1".into(),
                    visit_id: "v1".into(),
                    role: "implementation.driver".into(),
                },
            ),
            event(
                "e4",
                "r1",
                120,
                EventKind::AttemptStarted {
                    attempt_id: "t1".into(),
                    assignment_id: "a1".into(),
                },
            ),
        ];
        assert_eq!(store.append_boundary(&work).unwrap(), 2);
        let invalid_boundary = [
            event(
                "e5",
                "r1",
                130,
                EventKind::AttemptFinished {
                    attempt_id: "t1".into(),
                    outcome: WorkOutcome::Succeeded,
                },
            ),
            event(
                "e6",
                "r1",
                130,
                EventKind::PhaseEntered {
                    visit_id: "v2".into(),
                    phase: "define".into(),
                    visit_number: 1,
                },
            ),
        ];
        assert!(matches!(
            store.append_boundary(&invalid_boundary),
            Err(StoreError::InvalidHistory(_))
        ));
        assert_eq!(
            store.load_run("r1").unwrap().unwrap().attempts["t1"].outcome,
            None
        );
        store
            .append_boundary(&[
                event(
                    "e7",
                    "r1",
                    125,
                    EventKind::AttemptStarted {
                        attempt_id: "t2".into(),
                        assignment_id: "a1".into(),
                    },
                ),
                event(
                    "e8",
                    "r1",
                    135,
                    EventKind::AttemptFinished {
                        attempt_id: "t2".into(),
                        outcome: WorkOutcome::Succeeded,
                    },
                ),
            ])
            .unwrap();
    }
    {
        let mut store = SqliteEventStore::open(&path).unwrap();
        let run = store.load_run("r1").unwrap().unwrap();
        assert_eq!(run.attempts["t1"].outcome, Some(WorkOutcome::Interrupted));
        assert_eq!(run.attempts["t2"].outcome, Some(WorkOutcome::Succeeded));
        assert_eq!(run, store.replay_run("r1").unwrap().unwrap());
        assert_eq!(store.recover_interrupted().unwrap(), 0);
        assert!(matches!(
            store.append_boundary(&[event(
                "e5",
                "r1",
                130,
                EventKind::AttemptFinished {
                    attempt_id: "t1".into(),
                    outcome: WorkOutcome::Succeeded
                }
            )]),
            Err(StoreError::InvalidHistory(_))
        ));
    }
    let connection = Connection::open(&path).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 7);
    let pi_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE '%pi%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pi_tables, 0);
    drop(connection);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn conflicting_event_identity_does_not_change_state() {
    let mut store = SqliteEventStore::in_memory().unwrap();
    store.append_boundary(&started()).unwrap();
    let original = store.load_run("r1").unwrap();
    let conflict = event(
        "e2",
        "r1",
        100,
        EventKind::PhaseEntered {
            visit_id: "different".into(),
            phase: "intake".into(),
            visit_number: 1,
        },
    );
    assert!(matches!(
        store.append_boundary(&[conflict]),
        Err(StoreError::EventIdConflict(_))
    ));
    assert_eq!(store.load_run("r1").unwrap(), original);
}

#[test]
fn failed_disk_open_uses_an_explicit_volatile_store() {
    let (dir, _) = temp_db();
    let path = dir.join("missing").join("events.sqlite");
    let mut store = SqliteEventStore::open_or_volatile(path).unwrap();
    assert_eq!(store.durability(), Durability::Volatile);
    assert!(store.degraded_reason().is_some());
    store.append_boundary(&started()).unwrap();
    assert_eq!(store.load_run("r1").unwrap().unwrap().visits.len(), 1);
    fs::remove_dir_all(dir).unwrap();
}
