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
    knowledge::{
        Criterion, FeedbackReason, KnowledgeArtifact, KnowledgeOutput, PlannedAssignment, Story,
        WorkflowPolicy,
    },
    ports::{ArtifactReader, Clock, IdGenerator, RunReader, RunRepository},
    read_models::{RunProjection, replay},
    use_cases::{advance_run, finish_attempt, get_run_status, start_assignment, start_run},
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
struct Artifacts(BTreeSet<String>, BTreeMap<String, KnowledgeArtifact>);
impl ArtifactReader for Artifacts {
    type Error = io::Error;
    fn is_available(&self, path: &str) -> io::Result<bool> {
        Ok(self.0.contains(path))
    }
    fn read_contract(&self, path: &str) -> io::Result<Option<(KnowledgeArtifact, String)>> {
        Ok(self
            .1
            .get(path)
            .filter(|_| self.0.contains(path))
            .map(|document| (document.clone(), format!("{document:?}"))))
    }
    fn digest(&self, path: &str) -> io::Result<Option<String>> {
        Ok(self.1.get(path).map(|document| format!("{document:?}")))
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
                policy: None,
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
    ) -> Result<start_assignment::Outcome, ApplicationError> {
        start_assignment::execute(
            &mut self.store,
            &self.artifacts,
            &mut FixedClock,
            &mut self.ids,
            start_assignment::Request {
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
                approved_artifact_id: None,
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
            policy: None,
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
            policy: None,
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
            policy: None,
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
            policy: None,
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
        advance_run::Outcome {
            advanced: false,
            ..
        }
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
        advance_run::Outcome {
            advanced: false,
            ..
        }
    ));
    workflow
        .finish("session", &two.attempt_id, WorkOutcome::Cancelled)
        .unwrap();
    workflow.artifacts.0.clear();
    assert!(matches!(
        workflow.advance("session").unwrap(),
        advance_run::Outcome {
            advanced: false,
            ..
        }
    ));
    workflow.artifacts.0.insert(brief(&one.attempt_id));
    let advanced = workflow.advance("session").unwrap();
    assert!(advanced.advanced);
    assert_eq!(advanced.phase, "define");
    assert_eq!(workflow.store.boundaries.last().unwrap().len(), 5);
    let next_gate = workflow.advance("session").unwrap();
    assert!(!next_gate.advanced);
    assert_eq!(next_gate.phase, "define");
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
    assert_eq!(
        workflow.delegate("session", None).unwrap().role,
        "define.product"
    );
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

fn definition() -> KnowledgeOutput {
    KnowledgeOutput::DefinitionContract {
        goal: "Observable result".into(),
        scope: vec!["Small increment".into()],
        exclusions: vec![],
        criteria: vec![Criterion {
            id: "c1".into(),
            behavior: "Returns the result".into(),
            example: "Given A, returns B".into(),
        }],
    }
}
fn design(feasible: bool) -> KnowledgeOutput {
    KnowledgeOutput::DesignDecisions {
        approach: "Pure function".into(),
        interfaces: vec!["A -> B".into()],
        alternatives: vec!["Stateful implementation rejected".into()],
        risks: vec![],
        feasible,
    }
}
fn stories(independent: bool) -> KnowledgeOutput {
    KnowledgeOutput::StoryMap {
        stories: vec![Story {
            id: "s1".into(),
            value: "Observable result".into(),
            criteria: vec!["c1".into()],
            verification: vec!["assert result(A) == B".into()],
            independently_verifiable: independent,
            dependencies: vec![],
        }],
    }
}
fn plan() -> KnowledgeOutput {
    KnowledgeOutput::ExecutionPlan {
        assignments: [
            ("driver", "implementation.driver", vec![]),
            (
                "navigator",
                "implementation.navigator",
                vec!["driver".into()],
            ),
            ("verifier", "verify.verifier", vec!["navigator".into()]),
        ]
        .into_iter()
        .map(|(id, role, dependencies)| PlannedAssignment {
            id: id.into(),
            increment_id: "s1".into(),
            role: role.into(),
            dependencies,
            workspace: "increment-s1".into(),
            resources: vec![],
            max_attempts: 1,
            max_time_ms: 1000,
            max_cost_micros: 0,
        })
        .collect(),
    }
}
impl Workflow {
    fn start_with_policy(&mut self, policy: WorkflowPolicy) {
        start_run::execute(
            &mut self.store,
            &mut FixedClock,
            &mut self.ids,
            start_run::Request {
                session_id: "s",
                objective: "Synthetic workflow",
                policy: Some(&policy),
                routing: None,
                available_models: None,
                metadata: &AdapterMetadata {
                    adapter: "test".into(),
                    version: "1".into(),
                    capabilities: BTreeMap::from([("humanApproval".into(), true)]),
                },
            },
        )
        .unwrap();
    }
    fn submit(&mut self, output: Option<KnowledgeOutput>) -> (start_assignment::Outcome, String) {
        let assignment = self.delegate("s", None).unwrap();
        self.artifacts.0.insert(assignment.artifact_path.clone());
        if let Some(output) = output {
            self.artifacts.1.insert(
                assignment.artifact_path.clone(),
                KnowledgeArtifact {
                    schema_version: 1,
                    inputs: assignment
                        .input_artifacts
                        .iter()
                        .map(|a| a.artifact_id.clone())
                        .collect(),
                    output,
                },
            );
        }
        let result = finish_attempt::execute(
            &mut self.store,
            &self.artifacts,
            &mut FixedClock,
            &mut self.ids,
            finish_attempt::Request {
                session_id: "s",
                attempt_id: &assignment.attempt_id,
                outcome: WorkOutcome::Succeeded,
                artifact_path: Some(&assignment.artifact_path),
            },
        )
        .unwrap();
        (assignment, result.artifact_id.unwrap())
    }
    fn through(&mut self, phase: &str) {
        self.start("s").unwrap();
        for output in [
            None,
            Some(definition()),
            Some(design(true)),
            Some(stories(true)),
        ] {
            if self.status("s").run.unwrap().visits.last().unwrap().phase == phase {
                break;
            }
            self.submit(output);
            let gate = self.advance("s").unwrap();
            assert!(gate.advanced, "{gate:?}");
        }
    }
}

#[test]
fn all_knowledge_phases_use_artifacts_and_finish_with_a_ready_plan() {
    let mut workflow = Workflow::default();
    workflow.through("plan");
    let (assignment, artifact) = workflow.submit(Some(plan()));
    assert_eq!(assignment.role, "plan.planner");
    assert_eq!(assignment.input_artifacts.len(), 4);
    let result = workflow.advance("s").unwrap();
    assert!(result.advanced && result.ready);
    assert_eq!(result.phase, "plan");
    let run = workflow.status("s").run.unwrap();
    assert_eq!(run.accepted["plan"], artifact);
    assert_eq!(run.visits.len(), 6);
    assert_eq!(run.attempts.len(), 5);
    assert_eq!(replay(&workflow.store.events).unwrap().unwrap(), run);
    assert!(workflow.advance("s").unwrap().resumed);
    assert!(workflow.delegate("s", None).is_err());
}

#[test]
fn uncertainty_returns_to_its_origin_and_invalidates_downstream_artifacts() {
    for (reason, target, retained) in [
        (FeedbackReason::AmbiguousCriteria, "define", 1),
        (FeedbackReason::InfeasibleDesign, "design", 2),
        (FeedbackReason::OversizedStory, "breakdown", 3),
        (FeedbackReason::MissingContext, "discovery", 0),
    ] {
        let mut workflow = Workflow::default();
        workflow.through("plan");
        let (_, feedback) = workflow.submit(Some(KnowledgeOutput::Feedback {
            reason,
            evidence: "A concrete uncertainty".into(),
        }));
        let gate = workflow.advance("s").unwrap();
        assert!(gate.advanced);
        assert_eq!(gate.phase, target);
        let run = workflow.status("s").run.unwrap();
        assert_eq!(run.visits.last().unwrap().visit_number, 2);
        assert_eq!(run.accepted.len(), retained);
        assert_eq!(run.feedback.as_deref(), Some(feedback.as_str()));
        let next = workflow.delegate("s", None).unwrap();
        assert_eq!(next.input_artifacts.len(), retained + 1);
        assert!(
            next.input_artifacts
                .iter()
                .any(|a| a.artifact_id == feedback)
        );
    }
}

#[test]
fn invalid_design_and_unverifiable_stories_block_the_responsible_gate() {
    let mut workflow = Workflow::default();
    workflow.through("design");
    workflow.submit(Some(design(false)));
    assert!(!workflow.advance("s").unwrap().advanced);
    workflow.submit(Some(design(true)));
    assert_eq!(workflow.advance("s").unwrap().phase, "breakdown");
    workflow.submit(Some(stories(false)));
    let rejected = workflow.advance("s").unwrap();
    assert!(!rejected.advanced);
    assert!(
        rejected
            .reason
            .unwrap()
            .contains("independently verifiable")
    );
    let mut unknown = stories(true);
    if let KnowledgeOutput::StoryMap { stories } = &mut unknown {
        stories[0].criteria = vec!["unknown".into()];
    }
    workflow.submit(Some(unknown));
    assert!(
        workflow
            .advance("s")
            .unwrap()
            .reason
            .unwrap()
            .contains("criterion")
    );
    workflow.submit(Some(stories(true)));
    assert_eq!(workflow.advance("s").unwrap().phase, "plan");
}

#[test]
fn plan_rejects_cycles_unknown_dependencies_and_workspace_conflicts() {
    for defect in ["cycle", "unknown", "workspace", "coverage", "budget"] {
        let mut workflow = Workflow::default();
        workflow.through("plan");
        let mut output = plan();
        let KnowledgeOutput::ExecutionPlan { assignments } = &mut output else {
            unreachable!()
        };
        match defect {
            "cycle" => assignments[0].dependencies.push("verifier".into()),
            "unknown" => assignments[0].dependencies.push("missing".into()),
            "workspace" => assignments[1].dependencies.clear(),
            "coverage" => {
                assignments.pop();
            }
            _ => assignments[0].max_attempts = 100,
        }
        workflow.submit(Some(output));
        let result = workflow.advance("s").unwrap();
        assert!(!result.advanced && !result.ready, "{defect}: {result:?}");
    }
}

#[test]
fn human_gate_is_persisted_and_approval_is_bound_to_the_current_artifact() {
    let mut workflow = Workflow::default();
    workflow.start_with_policy(WorkflowPolicy {
        human_gates: vec!["define".into()],
        ..Default::default()
    });
    workflow.submit(None);
    workflow.advance("s").unwrap();
    let (assignment, artifact) = workflow.submit(Some(definition()));
    let waiting = workflow.advance("s").unwrap();
    assert_eq!(
        waiting.human_artifact_id.as_deref(),
        Some(artifact.as_str())
    );
    assert!(!waiting.advanced);
    let approve = |workflow: &mut Workflow, id: &str| {
        advance_run::execute(
            &mut workflow.store,
            &workflow.artifacts,
            &mut FixedClock,
            &mut workflow.ids,
            advance_run::Request {
                session_id: "s",
                approved_artifact_id: Some(id),
            },
        )
    };
    assert!(approve(&mut workflow, "stale-id").is_err());
    let original = workflow.artifacts.1[&assignment.artifact_path].clone();
    workflow
        .artifacts
        .1
        .get_mut(&assignment.artifact_path)
        .unwrap()
        .output = design(true);
    assert!(approve(&mut workflow, &artifact).is_err());
    workflow
        .artifacts
        .1
        .insert(assignment.artifact_path, original);
    assert_eq!(approve(&mut workflow, &artifact).unwrap().phase, "design");
    assert!(
        workflow
            .store
            .events
            .iter()
            .any(|e| matches!(e.kind, EventKind::HumanApproved { .. }))
    );
}

#[test]
fn wrong_input_contract_does_not_settle_and_changed_upstream_evidence_blocks() {
    let mut workflow = Workflow::default();
    workflow.through("design");
    let assignment = workflow.delegate("s", None).unwrap();
    workflow
        .artifacts
        .0
        .insert(assignment.artifact_path.clone());
    workflow.artifacts.1.insert(
        assignment.artifact_path.clone(),
        KnowledgeArtifact {
            schema_version: 1,
            inputs: vec![],
            output: design(true),
        },
    );
    assert!(
        finish_attempt::execute(
            &mut workflow.store,
            &workflow.artifacts,
            &mut FixedClock,
            &mut workflow.ids,
            finish_attempt::Request {
                session_id: "s",
                attempt_id: &assignment.attempt_id,
                outcome: WorkOutcome::Succeeded,
                artifact_path: Some(&assignment.artifact_path)
            }
        )
        .is_err()
    );
    assert_eq!(
        workflow.status("s").run.unwrap().attempts[&assignment.attempt_id].outcome,
        None
    );
    workflow
        .finish("s", &assignment.attempt_id, WorkOutcome::Failed)
        .unwrap();
    workflow.submit(Some(design(true)));
    let define = assignment
        .input_artifacts
        .iter()
        .find(|a| a.kind == "definition_contract")
        .unwrap();
    workflow
        .artifacts
        .1
        .get_mut(&define.path)
        .unwrap()
        .inputs
        .clear();
    assert!(
        workflow
            .advance("s")
            .unwrap()
            .reason
            .unwrap()
            .contains("input artifact")
    );
}

#[test]
fn dispatch_enforces_attempt_cost_concurrency_and_elapsed_time_budgets() {
    for policy in [
        WorkflowPolicy {
            max_attempts: 1,
            ..Default::default()
        },
        WorkflowPolicy {
            max_concurrency: 1,
            ..Default::default()
        },
        WorkflowPolicy {
            max_cost_micros: Some(10),
            attempt_cost_micros: 10,
            ..Default::default()
        },
    ] {
        let mut workflow = Workflow::default();
        workflow.start_with_policy(policy);
        workflow.delegate("s", None).unwrap();
        let count = workflow.store.events.len();
        assert!(workflow.delegate("s", None).is_err());
        assert_eq!(workflow.store.events.len(), count);
    }
    struct LateClock;
    impl Clock for LateClock {
        fn now(&mut self) -> Timestamp {
            Timestamp::from_millis(3_600_100)
        }
    }
    let mut workflow = Workflow::default();
    workflow.start("s").unwrap();
    assert!(
        start_assignment::execute(
            &mut workflow.store,
            &workflow.artifacts,
            &mut LateClock,
            &mut workflow.ids,
            start_assignment::Request {
                session_id: "s",
                retry_assignment_id: None
            }
        )
        .is_err()
    );
}

#[test]
fn failed_knowledge_gate_commit_does_not_leave_half_a_transition() {
    let mut workflow = Workflow::default();
    workflow.through("define");
    workflow.submit(Some(definition()));
    let before = workflow.store.events.clone();
    workflow.store.fail_next = true;
    assert!(workflow.advance("s").is_err());
    assert_eq!(workflow.store.events, before);
    assert_eq!(workflow.advance("s").unwrap().phase, "design");
}

#[test]
fn late_success_is_durably_a_timeout_and_can_be_replayed() {
    struct LateClock;
    impl Clock for LateClock {
        fn now(&mut self) -> Timestamp {
            Timestamp::from_millis(120_100)
        }
    }
    let mut workflow = Workflow::default();
    workflow.start("s").unwrap();
    let assignment = workflow.delegate("s", None).unwrap();
    let result = finish_attempt::execute(
        &mut workflow.store,
        &workflow.artifacts,
        &mut LateClock,
        &mut workflow.ids,
        finish_attempt::Request {
            session_id: "s",
            attempt_id: &assignment.attempt_id,
            outcome: WorkOutcome::Succeeded,
            artifact_path: Some(&assignment.artifact_path),
        },
    )
    .unwrap();
    assert_eq!(result.outcome, WorkOutcome::TimedOut);
    assert!(result.artifact_id.is_none());
    assert_eq!(
        workflow
            .finish("s", &assignment.attempt_id, WorkOutcome::Succeeded)
            .unwrap()
            .outcome,
        WorkOutcome::TimedOut
    );
    assert!(workflow.status("s").run.unwrap().artifacts.is_empty());
}

#[test]
fn accepted_legacy_discovery_is_an_input_after_replay() {
    let mut workflow = Workflow::default();
    workflow.through("define");
    workflow.store.events.retain(|e| {
        !matches!(
            e.kind,
            EventKind::WorkflowConfigured { .. }
                | EventKind::PhaseAccepted { .. }
                | EventKind::AssignmentInputs { .. }
                | EventKind::AttemptCharged { .. }
        )
    });
    let next = workflow.delegate("s", None).unwrap();
    assert_eq!(next.input_artifacts.len(), 1);
    assert_eq!(next.input_artifacts[0].kind, "discovery_brief");
}

#[test]
fn plan_requires_the_verification_of_prerequisite_increments() {
    let mut workflow = Workflow::default();
    workflow.through("breakdown");
    let mut output = stories(true);
    let KnowledgeOutput::StoryMap { stories } = &mut output else {
        unreachable!()
    };
    let mut second = stories[0].clone();
    second.id = "s2".into();
    second.dependencies = vec!["s1".into()];
    stories.push(second);
    workflow.submit(Some(output));
    assert!(workflow.advance("s").unwrap().advanced);
    let mut output = plan();
    let KnowledgeOutput::ExecutionPlan { assignments } = &mut output else {
        unreachable!()
    };
    let second: Vec<_> = assignments
        .iter()
        .map(|a| {
            let mut next = a.clone();
            next.id = format!("{}2", a.id);
            next.increment_id = "s2".into();
            next.workspace = "s2".into();
            next.dependencies = a.dependencies.iter().map(|id| format!("{id}2")).collect();
            next
        })
        .collect();
    assignments.extend(second);
    workflow.submit(Some(output.clone()));
    assert!(
        workflow
            .advance("s")
            .unwrap()
            .reason
            .unwrap()
            .contains("increment dependency")
    );
    let KnowledgeOutput::ExecutionPlan { assignments } = &mut output else {
        unreachable!()
    };
    assignments[3].dependencies.push("verifier".into());
    workflow.submit(Some(output));
    assert!(workflow.advance("s").unwrap().ready);
}

#[test]
fn concurrent_admission_is_rechecked_when_the_atomic_boundary_replays() {
    let mut workflow = Workflow::default();
    workflow.start_with_policy(WorkflowPolicy {
        max_concurrency: 1,
        ..Default::default()
    });
    let started = workflow.delegate("s", None).unwrap();
    let before = workflow.store.events.clone();
    let visit = workflow
        .status("s")
        .run
        .unwrap()
        .visits
        .last()
        .unwrap()
        .visit_id
        .clone();
    let race = [
        Event {
            event_id: "race-a".into(),
            run_id: started.run_id.clone(),
            occurred_at_ms: 100,
            kind: EventKind::AssignmentCreated {
                assignment_id: "racing-assignment".into(),
                visit_id: visit,
                role: "discovery.explorer".into(),
            },
        },
        Event {
            event_id: "race-t".into(),
            run_id: started.run_id,
            occurred_at_ms: 100,
            kind: EventKind::AttemptStarted {
                attempt_id: "racing-attempt".into(),
                assignment_id: "racing-assignment".into(),
                selection: None,
            },
        },
    ];
    assert!(workflow.store.append_boundary(&race).is_err());
    assert_eq!(workflow.store.events, before);
}
