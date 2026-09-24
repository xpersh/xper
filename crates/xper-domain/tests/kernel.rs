//! Acceptance tests for the deterministic domain kernel.

use xper_domain::{
    ArtifactId, ArtifactKind, ArtifactReference, Assignment, AssignmentId, AssignmentResult,
    AssignmentState, Attempt, AttemptId, AttemptResult, AttemptState, Clock, DomainEventKind,
    GateEvaluation, GateResult, IdGenerator, Identifier, Phase, PhaseVisitId, Run, RunResult,
    RunState, Timestamp, TransitionError, TransitionRequest,
};

#[derive(Clone)]
struct FixedClock {
    now: Timestamp,
    calls: usize,
}

impl FixedClock {
    fn at(milliseconds: u64) -> Self {
        Self {
            now: Timestamp::from_millis(milliseconds),
            calls: 0,
        }
    }
}

impl Clock for FixedClock {
    fn now(&mut self) -> Timestamp {
        self.calls += 1;
        self.now
    }
}

#[derive(Clone)]
struct SequentialIds {
    prefix: &'static str,
    next: u64,
}

impl SequentialIds {
    fn new(prefix: &'static str) -> Self {
        Self { prefix, next: 0 }
    }
}

impl IdGenerator for SequentialIds {
    fn next_id(&mut self) -> Identifier {
        self.next += 1;
        Identifier::new(format!("{}-{}", self.prefix, self.next)).unwrap()
    }
}

fn id(value: &str) -> Identifier {
    Identifier::new(value).unwrap()
}

fn passed(request_id: &str, target: Phase) -> TransitionRequest {
    TransitionRequest::new(
        id(request_id).into(),
        target,
        GateEvaluation::new("exit", GateResult::Passed, Vec::new()),
    )
}

#[test]
fn follows_the_minimal_valid_path_and_emits_events_for_each_change() {
    let mut clock = FixedClock::at(100);
    let mut ids = SequentialIds::new("domain");
    let started = Run::start("deliver a deterministic kernel", &mut clock, &mut ids);

    assert_eq!(started.events().len(), 2);
    assert!(matches!(
        started.events()[0].kind(),
        DomainEventKind::RunStarted { .. }
    ));
    assert!(matches!(
        started.events()[1].kind(),
        DomainEventKind::PhaseEntered {
            phase: Phase::Intake,
            visit_number: 1,
            ..
        }
    ));

    let (mut run, _) = started.into_parts();
    let discovery = run
        .transition(
            passed("request-discovery", Phase::Discovery),
            &mut clock,
            &mut ids,
        )
        .unwrap();
    assert_eq!(run.current_phase(), Phase::Discovery);
    assert_eq!(discovery.events().len(), 4);
    assert!(matches!(
        discovery.events()[3].kind(),
        DomainEventKind::PhaseEntered {
            phase: Phase::Discovery,
            visit_number: 1,
            ..
        }
    ));

    let defined = run
        .transition(
            passed("request-define", Phase::Define),
            &mut clock,
            &mut ids,
        )
        .unwrap();
    assert_eq!(run.current_phase(), Phase::Define);
    assert_eq!(run.phase_visits().len(), 3);
    assert_eq!(run.gates().len(), 2);
    assert!(matches!(
        defined.events()[3].kind(),
        DomainEventKind::PhaseEntered {
            phase: Phase::Define,
            visit_number: 1,
            ..
        }
    ));
}

#[test]
fn rejects_invalid_edges_and_failed_gates_without_side_effects() {
    let mut clock = FixedClock::at(200);
    let mut ids = SequentialIds::new("domain");
    let (mut run, _) = Run::start("reject bad transitions", &mut clock, &mut ids).into_parts();
    let before = run.clone();
    let calls_before = (clock.calls, ids.next);

    let error = run
        .transition(
            passed("skip-discovery", Phase::Define),
            &mut clock,
            &mut ids,
        )
        .unwrap_err();
    assert_eq!(error.code(), "invalid_transition");
    assert_eq!(
        error,
        TransitionError::InvalidTransition {
            from: Phase::Intake,
            target: Phase::Define,
        }
    );
    assert_eq!(run, before);
    assert_eq!((clock.calls, ids.next), calls_before);

    let failed_gate = TransitionRequest::new(
        id("failed-gate").into(),
        Phase::Discovery,
        GateEvaluation::new(
            "intake.complete",
            GateResult::Failed {
                reasons: vec!["scope is missing".into()],
            },
            Vec::new(),
        ),
    );
    let error = run
        .transition(failed_gate, &mut clock, &mut ids)
        .unwrap_err();
    assert_eq!(error.code(), "gate_not_passed");
    assert_eq!(run, before);
    assert_eq!((clock.calls, ids.next), calls_before);
}

#[test]
fn records_revisits_as_new_numbered_phase_visits() {
    let mut clock = FixedClock::at(300);
    let mut ids = SequentialIds::new("domain");
    let (mut run, _) = Run::start("revisit discovery", &mut clock, &mut ids).into_parts();
    run.transition(
        passed("to-discovery", Phase::Discovery),
        &mut clock,
        &mut ids,
    )
    .unwrap();
    run.transition(passed("to-define", Phase::Define), &mut clock, &mut ids)
        .unwrap();

    let receipt = run
        .transition(
            passed("back-to-discovery", Phase::Discovery),
            &mut clock,
            &mut ids,
        )
        .unwrap();

    assert_eq!(run.current_phase(), Phase::Discovery);
    assert_eq!(run.current_visit().visit_number(), 2);
    assert!(matches!(
        receipt.events()[3].kind(),
        DomainEventKind::PhaseRevisited {
            phase: Phase::Discovery,
            visit_number: 2,
            ..
        }
    ));
}

#[test]
fn replay_is_idempotent_and_a_conflicting_reuse_is_rejected() {
    let mut clock = FixedClock::at(400);
    let mut ids = SequentialIds::new("domain");
    let (mut run, _) = Run::start("replay safely", &mut clock, &mut ids).into_parts();
    let request = passed("same-request", Phase::Discovery);

    let first = run
        .transition(request.clone(), &mut clock, &mut ids)
        .unwrap();
    let state_after_first = run.clone();
    let calls_after_first = (clock.calls, ids.next);
    let replay = run.transition(request, &mut clock, &mut ids).unwrap();

    assert_eq!(replay, first);
    assert_eq!(run, state_after_first);
    assert_eq!((clock.calls, ids.next), calls_after_first);

    let conflict = run
        .transition(
            TransitionRequest::new(
                id("same-request").into(),
                Phase::Discovery,
                GateEvaluation::new("different-gate", GateResult::Passed, Vec::new()),
            ),
            &mut clock,
            &mut ids,
        )
        .unwrap_err();
    assert_eq!(conflict.code(), "idempotency_conflict");
    assert_eq!(run, state_after_first);
    assert_eq!((clock.calls, ids.next), calls_after_first);
}

#[test]
fn identical_inputs_and_sources_produce_identical_state_and_events() {
    fn execute() -> (Run, Vec<xper_domain::DomainEvent>) {
        let mut clock = FixedClock::at(500);
        let mut ids = SequentialIds::new("repeatable");
        let (mut run, mut events) = Run::start("same input", &mut clock, &mut ids).into_parts();
        let transition = run
            .transition(
                passed("deterministic", Phase::Discovery),
                &mut clock,
                &mut ids,
            )
            .unwrap();
        events.extend_from_slice(transition.events());
        (run, events)
    }

    assert_eq!(execute(), execute());
}

#[test]
fn terminal_results_distinguish_failure_cancellation_and_timeout() {
    let phase_visit_id = PhaseVisitId::from(id("visit"));
    let assignment_id = AssignmentId::from(id("assignment"));
    let artifact = ArtifactReference::new(
        ArtifactId::from(id("artifact")),
        ArtifactKind::DiscoveryBrief,
        1,
    );

    let assignment = Assignment::new(
        assignment_id.clone(),
        phase_visit_id,
        "discovery.explorer",
        AssignmentState::Finished(AssignmentResult::TimedOut),
    );
    let attempt = Attempt::new(
        AttemptId::from(id("attempt")),
        assignment_id,
        AttemptState::Finished(AttemptResult::Cancelled),
    );

    assert_eq!(
        assignment.state(),
        &AssignmentState::Finished(AssignmentResult::TimedOut)
    );
    assert_eq!(
        attempt.state(),
        &AttemptState::Finished(AttemptResult::Cancelled)
    );
    assert_ne!(
        RunState::Finished(RunResult::Failed {
            reason: "broken".into()
        }),
        RunState::Finished(RunResult::Cancelled)
    );
    assert_ne!(
        AttemptResult::Succeeded {
            artifacts: vec![artifact]
        },
        AttemptResult::TimedOut
    );
}

#[test]
fn identifiers_are_non_empty_and_neutral() {
    assert!(Identifier::new("").is_err());
    assert!(Identifier::new("   ").is_err());
    assert_eq!(id("run-123").as_str(), "run-123");
}
