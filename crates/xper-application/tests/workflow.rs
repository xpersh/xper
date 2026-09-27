//! Use-case acceptance tests with deterministic ports and no filesystem or harness.

use std::{
    collections::{BTreeMap, BTreeSet},
    io,
};
use xper_application::{
    ApplicationError,
    events::{
        AdapterMetadata, Event, EventKind, GateOutcome, ModelSelection, RoutingSnapshot,
        WorkOutcome,
    },
    ports::{ArtifactReader, Clock, IdGenerator, RunReader, RunRepository},
    read_models::{RunProjection, replay},
    use_cases::{advance_run, finish_attempt, get_run_status, start_discovery, start_run},
};
use xper_domain::{Identifier, Timestamp};

#[derive(Default)]
struct MemoryStore {
    events: Vec<Event>,
    sessions: BTreeMap<String, String>,
    boundaries: Vec<Vec<Event>>,
    fail_next: bool,
}

impl RunReader for MemoryStore {
    type Error = io::Error;

    fn load_run(&self, id: &str) -> io::Result<Option<RunProjection>> {
        replay(&self.load_events(id)?).map_err(io::Error::other)
    }
    fn load_events(&self, id: &str) -> io::Result<Vec<Event>> {
        Ok(self
            .events
            .iter()
            .filter(|e| e.run_id == id)
            .cloned()
            .collect())
    }
    fn latest_run(&self) -> io::Result<Option<RunProjection>> {
        self.events
            .iter()
            .rev()
            .find(|event| matches!(event.kind, EventKind::RunStarted { .. }))
            .map(|event| self.load_run(&event.run_id))
            .transpose()
            .map(Option::flatten)
    }
    fn session_run(&self, session_id: &str) -> io::Result<Option<String>> {
        Ok(self.sessions.get(session_id).cloned())
    }
}

impl RunRepository for MemoryStore {
    fn append_boundary(&mut self, events: &[Event]) -> io::Result<usize> {
        if std::mem::take(&mut self.fail_next) {
            return Err(io::Error::other("commit failed"));
        }
        let mut history = self.load_events(&events[0].run_id)?;
        history.extend_from_slice(events);
        replay(&history).map_err(io::Error::other)?;
        self.events.extend_from_slice(events);
        self.boundaries.push(events.to_vec());
        Ok(events.len())
    }
    fn append_boundary_and_bind_session(
        &mut self,
        events: &[Event],
        session: &str,
        run: &str,
    ) -> io::Result<usize> {
        let count = self.append_boundary(events)?;
        self.sessions.insert(session.into(), run.into());
        Ok(count)
    }
}

struct FixedClock;
impl Clock for FixedClock {
    fn now(&mut self) -> Timestamp {
        Timestamp::from_millis(100)
    }
}
#[derive(Default)]
struct SequentialIds(u64);
impl IdGenerator for SequentialIds {
    fn next_id(&mut self) -> Identifier {
        self.0 += 1;
        Identifier::new(format!("id-{}", self.0)).unwrap()
    }
}
#[derive(Default)]
struct Artifacts(BTreeSet<String>);
impl ArtifactReader for Artifacts {
    type Error = io::Error;
    fn is_available(&self, path: &str) -> io::Result<bool> {
        Ok(self.0.contains(path))
    }
}

#[derive(Default)]
struct Workflow {
    store: MemoryStore,
    ids: SequentialIds,
    artifacts: Artifacts,
}
impl Workflow {
    fn start(&mut self, session: &str) -> Result<start_run::Outcome, ApplicationError> {
        start_run::execute(
            &mut self.store,
            &mut FixedClock,
            &mut self.ids,
            start_run::Request {
                session_id: session,
                objective: "Explore the repository",
                routing: None,
                available_models: None,
                metadata: &AdapterMetadata {
                    adapter: "test".into(),
                    version: "1".into(),
                    capabilities: BTreeMap::new(),
                },
            },
        )
    }
    fn delegate(
        &mut self,
        session: &str,
        retry: Option<&str>,
    ) -> Result<start_discovery::Outcome, ApplicationError> {
        start_discovery::execute(
            &mut self.store,
            &mut FixedClock,
            &mut self.ids,
            start_discovery::Request {
                session_id: session,
                retry_assignment_id: retry,
            },
        )
    }
    fn finish(
        &mut self,
        session: &str,
        attempt: &str,
        outcome: WorkOutcome,
    ) -> Result<finish_attempt::Outcome, ApplicationError> {
        finish_attempt::execute(
            &mut self.store,
            &self.artifacts,
            &mut FixedClock,
            &mut self.ids,
            finish_attempt::Request {
                session_id: session,
                attempt_id: attempt,
                outcome,
                artifact_path: Some(&brief(attempt)),
            },
        )
    }
    fn advance(&mut self, session: &str) -> Result<advance_run::Outcome, ApplicationError> {
        advance_run::execute(
            &mut self.store,
            &self.artifacts,
            &mut FixedClock,
            &mut self.ids,
            advance_run::Request {
                session_id: session,
            },
        )
    }
    fn status(&self, session: &str) -> get_run_status::Outcome {
        get_run_status::execute(&self.store, get_run_status::Query::Session(session)).unwrap()
    }
}
fn brief(attempt: &str) -> String {
    format!(".xper/artifacts/discovery-brief-{attempt}.md")
}

#[test]
fn routed_failure_finishes_after_one_attempt_and_keeps_exact_selection() {
    let mut workflow = Workflow::default();
    let selected = ModelSelection {
        context: "company".into(),
        provider: "corp".into(),
        model: "m1".into(),
        thinking: "low".into(),
    };
    let routing = RoutingSnapshot {
        profile: "work".into(),
        context: "company".into(),
        routes: BTreeMap::from([("discovery.explorer".into(), vec![selected.clone()])]),
    };
    let metadata = AdapterMetadata {
        adapter: "test".into(),
        version: "1".into(),
        capabilities: BTreeMap::new(),
    };
    let model = start_run::AvailableModel {
        provider: "corp".into(),
        model: "m1".into(),
        reasoning: true,
    };
    let invalid = start_run::execute(
        &mut workflow.store,
        &mut FixedClock,
        &mut workflow.ids,
        start_run::Request {
            session_id: "s",
            objective: "Investigate",
            metadata: &metadata,
            routing: Some(&routing),
            available_models: Some(&[]),
        },
    );
    assert!(matches!(invalid, Err(ApplicationError::InvalidInput(_))));
    assert!(workflow.store.events.is_empty());
    let incapable = start_run::AvailableModel {
        reasoning: false,
        ..model.clone()
    };
    let invalid = start_run::execute(
        &mut workflow.store,
        &mut FixedClock,
        &mut workflow.ids,
        start_run::Request {
            session_id: "s",
            objective: "Investigate",
            metadata: &metadata,
            routing: Some(&routing),
            available_models: Some(&[incapable]),
        },
    );
    assert!(matches!(invalid, Err(ApplicationError::InvalidInput(_))));
    let started = start_run::execute(
        &mut workflow.store,
        &mut FixedClock,
        &mut workflow.ids,
        start_run::Request {
            session_id: "s",
            objective: "Investigate",
            metadata: &metadata,
            routing: Some(&routing),
            available_models: Some(&[model]),
        },
    )
    .unwrap();
    let attempt = workflow.delegate("s", None).unwrap();
    assert_eq!(attempt.selection, Some(selected.clone()));
    workflow
        .finish("s", &attempt.attempt_id, WorkOutcome::Failed)
        .unwrap();
    let run = workflow.store.load_run(&started.run_id).unwrap().unwrap();
    assert_eq!(run.routing, Some(routing));
    assert_eq!(run.attempts[&attempt.attempt_id].selection, Some(selected));
    assert_eq!(run.attempts.len(), 1);
    assert_eq!(
        run.assignments[&attempt.assignment_id].outcome,
        Some(WorkOutcome::Failed)
    );
    assert!(
        workflow
            .delegate("s", Some(&attempt.assignment_id))
            .is_err()
    );
    let mut corrupt = workflow.store.events.clone();
    let event = corrupt
        .iter_mut()
        .find(|event| matches!(event.kind, EventKind::AttemptStarted { .. }))
        .unwrap();
    if let EventKind::AttemptStarted {
        selection: Some(selection),
        ..
    } = &mut event.kind
    {
        selection.context = "personal".into();
    }
    assert!(replay(&corrupt).is_err());
}

#[test]
fn start_is_atomic_resumable_and_deterministic() {
    let mut workflow = Workflow::default();
    let first = workflow.start("session").unwrap();
    assert_eq!(first.phase.as_deref(), Some("discovery"));
    assert!(!first.resumed);
    assert_eq!(workflow.store.boundaries.len(), 1);
    let ids_before = workflow.ids.0;
    let resumed = workflow.start("session").unwrap();
    assert_eq!(resumed.run_id, first.run_id);
    assert!(resumed.resumed);
    assert_eq!(workflow.ids.0, ids_before);
    assert_eq!(workflow.store.boundaries.len(), 1);
    let mut independent = Workflow::default();
    independent.start("session").unwrap();
    assert_eq!(workflow.store.events, independent.store.events);
    assert!(
        workflow
            .store
            .events
            .iter()
            .all(|e| e.occurred_at_ms == 100)
    );
}

#[test]
fn failed_start_does_not_bind_a_session_or_leave_a_partial_run() {
    let mut workflow = Workflow::default();
    workflow.store.fail_next = true;
    assert!(matches!(
        workflow.start("session"),
        Err(ApplicationError::Dependency(_))
    ));
    assert!(workflow.store.events.is_empty());
    assert!(workflow.store.sessions.is_empty());
    assert!(!workflow.start("session").unwrap().resumed);
}

#[test]
fn direct_callers_cannot_start_an_empty_objective_or_delegate_without_a_run() {
    let mut workflow = Workflow::default();
    assert!(matches!(
        workflow.delegate("session", None),
        Err(ApplicationError::InvalidInput(_))
    ));
    let metadata = AdapterMetadata {
        adapter: "test".into(),
        version: "1".into(),
        capabilities: BTreeMap::new(),
    };
    let result = start_run::execute(
        &mut workflow.store,
        &mut FixedClock,
        &mut workflow.ids,
        start_run::Request {
            session_id: "session",
            objective: "  ",
            metadata: &metadata,
            routing: None,
            available_models: None,
        },
    );
    assert!(matches!(result, Err(ApplicationError::InvalidInput(_))));
    assert!(workflow.store.events.is_empty());
}

#[test]
fn missing_or_wrong_evidence_never_settles_a_successful_attempt() {
    let mut workflow = Workflow::default();
    workflow.start("session").unwrap();
    assert!(matches!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome::Blocked { .. }
    ));
    let run = workflow.status("session").run.unwrap();
    assert_eq!(
        run.gates.values().next().unwrap().outcome,
        GateOutcome::Failed
    );
    let attempt = workflow.delegate("session", None).unwrap();
    let history = workflow.store.events.clone();
    assert!(matches!(
        workflow.finish("session", &attempt.attempt_id, WorkOutcome::Succeeded),
        Err(ApplicationError::InvalidInput(_))
    ));
    workflow.artifacts.0.insert("some-other-brief.md".into());
    let result = finish_attempt::execute(
        &mut workflow.store,
        &workflow.artifacts,
        &mut FixedClock,
        &mut workflow.ids,
        finish_attempt::Request {
            session_id: "session",
            attempt_id: &attempt.attempt_id,
            outcome: WorkOutcome::Succeeded,
            artifact_path: Some("some-other-brief.md"),
        },
    );
    assert!(matches!(result, Err(ApplicationError::InvalidInput(_))));
    assert_eq!(workflow.store.events, history);
    assert_eq!(
        workflow.status("session").run.unwrap().attempts[&attempt.attempt_id].outcome,
        None
    );
}

#[test]
fn discovery_waits_for_parallel_work_and_rechecks_artifact_availability() {
    let mut workflow = Workflow::default();
    workflow.start("session").unwrap();
    let one = workflow.delegate("session", None).unwrap();
    let two = workflow.delegate("session", None).unwrap();
    workflow.artifacts.0.insert(brief(&one.attempt_id));
    workflow
        .finish("session", &one.attempt_id, WorkOutcome::Succeeded)
        .unwrap();
    assert!(matches!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome::Blocked { .. }
    ));
    workflow
        .finish("session", &two.attempt_id, WorkOutcome::Cancelled)
        .unwrap();
    workflow.artifacts.0.clear();
    assert!(matches!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome::Blocked { .. }
    ));
    workflow.artifacts.0.insert(brief(&one.attempt_id));
    assert_eq!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome::Advanced { resumed: false }
    );
    assert_eq!(workflow.store.boundaries.last().unwrap().len(), 4);
    let history = workflow.store.events.clone();
    assert_eq!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome::Advanced { resumed: true }
    );
    assert_eq!(workflow.store.events, history);
    assert_eq!(
        workflow
            .status("session")
            .run
            .unwrap()
            .visits
            .last()
            .unwrap()
            .phase,
        "define"
    );
    assert!(workflow.delegate("session", None).is_err());
}

#[test]
fn terminal_outcomes_remain_distinct_and_retries_of_results_are_idempotent() {
    for outcome in [
        WorkOutcome::Succeeded,
        WorkOutcome::Failed,
        WorkOutcome::Cancelled,
        WorkOutcome::TimedOut,
    ] {
        let mut workflow = Workflow::default();
        workflow.start("session").unwrap();
        let assignment = workflow.delegate("session", None).unwrap();
        workflow.artifacts.0.insert(brief(&assignment.attempt_id));
        let result = workflow
            .finish("session", &assignment.attempt_id, outcome)
            .unwrap();
        assert_eq!(result.outcome, outcome);
        assert_eq!(
            result.artifact_id.is_some(),
            outcome == WorkOutcome::Succeeded
        );
        let history = workflow.store.events.clone();
        assert!(
            workflow
                .finish("session", &assignment.attempt_id, outcome)
                .unwrap()
                .replayed
        );
        let different = if outcome == WorkOutcome::Failed {
            WorkOutcome::Cancelled
        } else {
            WorkOutcome::Failed
        };
        assert!(
            workflow
                .finish("session", &assignment.attempt_id, different)
                .is_err()
        );
        assert_eq!(workflow.store.events, history);
        let run = workflow.status("session").run.unwrap();
        assert_eq!(
            run.assignments[&assignment.assignment_id].outcome,
            Some(outcome)
        );
        assert_eq!(run.attempts[&assignment.attempt_id].outcome, Some(outcome));
    }
}

#[test]
fn interrupted_work_can_retry_the_same_assignment_but_running_work_cannot() {
    let mut workflow = Workflow::default();
    workflow.start("session").unwrap();
    let first = workflow.delegate("session", None).unwrap();
    assert!(
        workflow
            .delegate("session", Some(&first.assignment_id))
            .is_err()
    );
    assert!(
        workflow
            .finish("session", &first.attempt_id, WorkOutcome::Interrupted)
            .is_err()
    );
    // Recovery is a store concern; application sees its normalized durable event.
    workflow
        .store
        .append_boundary(&[Event {
            event_id: "recovery-event".into(),
            run_id: first.run_id.clone(),
            occurred_at_ms: 100,
            kind: EventKind::AttemptFinished {
                attempt_id: first.attempt_id.clone(),
                outcome: WorkOutcome::Interrupted,
            },
        }])
        .unwrap();
    let retry = workflow
        .delegate("session", Some(&first.assignment_id))
        .unwrap();
    assert_eq!(retry.assignment_id, first.assignment_id);
    assert_ne!(retry.attempt_id, first.attempt_id);
    assert_eq!(workflow.status("session").run.unwrap().attempts.len(), 2);
}

#[test]
fn session_queries_and_mutations_do_not_cross_run_boundaries() {
    let mut workflow = Workflow::default();
    let one = workflow.start("one").unwrap();
    let two = workflow.start("two").unwrap();
    assert_ne!(one.run_id, two.run_id);
    let assignment = workflow.delegate("one", None).unwrap();
    assert!(
        workflow
            .finish("two", &assignment.attempt_id, WorkOutcome::Failed)
            .is_err()
    );
    assert!(
        workflow
            .delegate("two", Some(&assignment.assignment_id))
            .is_err()
    );
    assert!(workflow.status("two").run.unwrap().attempts.is_empty());
    let latest = get_run_status::execute(&workflow.store, get_run_status::Query::Latest).unwrap();
    assert_eq!(latest.run.unwrap().run_id, two.run_id);
    let by_id =
        get_run_status::execute(&workflow.store, get_run_status::Query::Run(&one.run_id)).unwrap();
    assert_eq!(by_id, workflow.status("one"));
}

#[test]
fn failed_settlement_keeps_attempt_and_artifact_uncommitted() {
    let mut workflow = Workflow::default();
    workflow.start("session").unwrap();
    let assignment = workflow.delegate("session", None).unwrap();
    workflow.artifacts.0.insert(brief(&assignment.attempt_id));
    let before = workflow.status("session");
    workflow.store.fail_next = true;
    assert!(matches!(
        workflow.finish("session", &assignment.attempt_id, WorkOutcome::Succeeded),
        Err(ApplicationError::Dependency(_))
    ));
    assert_eq!(workflow.status("session"), before);
    workflow
        .finish("session", &assignment.attempt_id, WorkOutcome::Succeeded)
        .unwrap();
    assert_eq!(workflow.store.boundaries.last().unwrap().len(), 3);
}

#[test]
fn status_handles_empty_and_unknown_runs_without_writes() {
    let workflow = Workflow::default();
    assert_eq!(
        workflow.status("absent"),
        get_run_status::Outcome::default()
    );
    assert_eq!(
        get_run_status::execute(&workflow.store, get_run_status::Query::Latest).unwrap(),
        get_run_status::Outcome::default()
    );
    assert!(
        get_run_status::execute(&workflow.store, get_run_status::Query::Run("absent")).is_err()
    );
    assert!(workflow.store.boundaries.is_empty());
}
