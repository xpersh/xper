//! Harness-neutral, privacy-bounded events and deterministic run projection.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use xper_domain::{DomainEvent, DomainEventKind, GateResult, Phase};

/// The only supported event payload version.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

/// Adapter identity captured at the start of a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterMetadata {
    /// Harness-neutral adapter name.
    pub adapter: String,
    /// Adapter version at run start.
    pub version: String,
    /// Advertised boolean capabilities.
    pub capabilities: BTreeMap<String, bool>,
}

/// A durable event. Payloads are a closed whitelist: transcripts, prompts,
/// source code, and tool arguments cannot be serialized through this API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// Globally unique idempotency key.
    pub event_id: String,
    /// Owning run identifier.
    pub run_id: String,
    /// Event time in Unix milliseconds.
    pub occurred_at_ms: u64,
    /// Whitelisted event payload.
    pub kind: EventKind,
}

impl Event {
    /// Converts an existing domain event to the durable vocabulary. The run
    /// objective and gate evidence are deliberately omitted.
    pub fn from_domain(event: &DomainEvent, metadata: &AdapterMetadata) -> Self {
        let kind = match event.kind() {
            DomainEventKind::RunStarted { .. } => EventKind::RunStarted {
                metadata: metadata.clone(),
            },
            DomainEventKind::PhaseEntered {
                phase_visit_id,
                phase,
                visit_number,
            } => EventKind::PhaseEntered {
                visit_id: phase_visit_id.as_str().to_owned(),
                phase: phase_name(*phase).to_owned(),
                visit_number: *visit_number,
            },
            DomainEventKind::PhaseRevisited {
                phase_visit_id,
                phase,
                visit_number,
            } => EventKind::PhaseRevisited {
                visit_id: phase_visit_id.as_str().to_owned(),
                phase: phase_name(*phase).to_owned(),
                visit_number: *visit_number,
            },
            DomainEventKind::GateEvaluated {
                gate_id,
                phase_visit_id,
                result,
            } => EventKind::GateEvaluated {
                gate_id: gate_id.as_str().to_owned(),
                visit_id: phase_visit_id.as_str().to_owned(),
                outcome: match result {
                    GateResult::Passed => GateOutcome::Passed,
                    GateResult::Failed { .. } => GateOutcome::Failed,
                    GateResult::HumanDecisionRequired { .. } => GateOutcome::HumanDecisionRequired,
                },
            },
            DomainEventKind::GatePassed {
                gate_id,
                phase_visit_id,
            } => EventKind::GatePassed {
                gate_id: gate_id.as_str().to_owned(),
                visit_id: phase_visit_id.as_str().to_owned(),
            },
            DomainEventKind::PhaseExited {
                phase_visit_id,
                phase,
                gate_id,
            } => EventKind::PhaseExited {
                visit_id: phase_visit_id.as_str().to_owned(),
                phase: phase_name(*phase).to_owned(),
                gate_id: gate_id.as_str().to_owned(),
            },
        };
        Self {
            event_id: event.id().as_str().to_owned(),
            run_id: event.run_id().as_str().to_owned(),
            occurred_at_ms: event.occurred_at().as_millis(),
            kind,
        }
    }
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Intake => "intake",
        Phase::Discovery => "discovery",
        Phase::Define => "define",
        Phase::Design => "design",
        Phase::Breakdown => "breakdown",
        Phase::Plan => "plan",
        Phase::Implementation => "implementation",
        Phase::Verify => "verify",
        Phase::JudgmentDay => "judgment_day",
        Phase::LearnClose => "learn_close",
    }
}

/// A normalized gate outcome. Evidence and free-text reasons are not retained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateOutcome {
    /// The gate passed.
    Passed,
    /// The gate failed.
    Failed,
    /// The gate needs a human decision.
    HumanDecisionRequired,
}

/// A normalized outcome for an assignment or attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkOutcome {
    /// Work succeeded.
    Succeeded,
    /// Work failed.
    Failed,
    /// Work was cancelled.
    Cancelled,
    /// Work exceeded its time limit.
    TimedOut,
    /// Work was still running when the store recovered.
    Interrupted,
}

/// Explicit event variants accepted by the store.
#[allow(missing_docs)] // The variant fields are the versioned wire schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    RunStarted {
        metadata: AdapterMetadata,
    },
    RunSuspended,
    RunResumed,
    RunCompleted,
    RunFailed,
    PhaseEntered {
        visit_id: String,
        phase: String,
        visit_number: u32,
    },
    PhaseRevisited {
        visit_id: String,
        phase: String,
        visit_number: u32,
    },
    PhaseExited {
        visit_id: String,
        phase: String,
        gate_id: String,
    },
    GateEvaluated {
        gate_id: String,
        visit_id: String,
        outcome: GateOutcome,
    },
    GatePassed {
        gate_id: String,
        visit_id: String,
    },
    AssignmentCreated {
        assignment_id: String,
        visit_id: String,
        role: String,
    },
    AssignmentCompleted {
        assignment_id: String,
        outcome: WorkOutcome,
    },
    AttemptStarted {
        attempt_id: String,
        assignment_id: String,
    },
    AttemptFinished {
        attempt_id: String,
        outcome: WorkOutcome,
    },
}

impl EventKind {
    /// Stable type name stored outside the JSON payload for indexing.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run.started",
            Self::RunSuspended => "run.suspended",
            Self::RunResumed => "run.resumed",
            Self::RunCompleted => "run.completed",
            Self::RunFailed => "run.failed",
            Self::PhaseEntered { .. } => "phase.entered",
            Self::PhaseRevisited { .. } => "phase.revisited",
            Self::PhaseExited { .. } => "phase.exited",
            Self::GateEvaluated { .. } => "gate.evaluated",
            Self::GatePassed { .. } => "gate.passed",
            Self::AssignmentCreated { .. } => "assignment.created",
            Self::AssignmentCompleted { .. } => "assignment.completed",
            Self::AttemptStarted { .. } => "attempt.started",
            Self::AttemptFinished { outcome, .. } => match outcome {
                WorkOutcome::Succeeded => "attempt.settled",
                WorkOutcome::Failed => "attempt.failed",
                WorkOutcome::Cancelled => "attempt.aborted",
                WorkOutcome::TimedOut => "attempt.timed_out",
                WorkOutcome::Interrupted => "attempt.interrupted",
            },
        }
    }
}

/// Current run lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Run accepts changes.
    Active,
    /// Run is paused.
    Suspended,
    /// Run completed.
    Completed,
    /// Run failed.
    Failed,
}

/// Current phase visit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisitProjection {
    /// Identity of this visit.
    pub visit_id: String,
    /// Workflow phase name.
    pub phase: String,
    /// One-based ordinal for this phase.
    pub visit_number: u32,
    /// Entry time in Unix milliseconds.
    pub entered_at_ms: u64,
    /// Exit time if the visit ended.
    pub exited_at_ms: Option<u64>,
    /// Gate that authorized the exit.
    pub exit_gate_id: Option<String>,
}

/// Current logical assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignmentProjection {
    /// Identity of this assignment.
    pub assignment_id: String,
    /// Owning phase visit.
    pub visit_id: String,
    /// Harness-neutral role name.
    pub role: String,
    /// Explicit terminal outcome, if any.
    pub outcome: Option<WorkOutcome>,
}

/// Current physical attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptProjection {
    /// Identity of this attempt.
    pub attempt_id: String,
    /// Owning logical assignment.
    pub assignment_id: String,
    /// Start time in Unix milliseconds.
    pub started_at_ms: u64,
    /// Finish time, if an explicit terminal event exists.
    pub finished_at_ms: Option<u64>,
    /// Explicit terminal outcome, if any.
    pub outcome: Option<WorkOutcome>,
}

/// One gate evaluation and any subsequent pass event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateProjection {
    /// Identity of the gate evaluation.
    pub gate_id: String,
    /// Phase visit evaluated by this gate.
    pub visit_id: String,
    /// Normalized evaluation outcome.
    pub outcome: GateOutcome,
    /// Evaluation time in Unix milliseconds.
    pub evaluated_at_ms: u64,
    /// Whether a matching pass event followed.
    pub passed: bool,
}

/// Deterministic state derived entirely from the ordered event stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunProjection {
    /// Identity of this run.
    pub run_id: String,
    /// Current run lifecycle state.
    pub status: RunStatus,
    /// Adapter identity captured at run start.
    pub metadata: AdapterMetadata,
    /// Visits in event order.
    pub visits: Vec<VisitProjection>,
    /// Gate evaluations keyed by identity.
    pub gates: BTreeMap<String, GateProjection>,
    /// Assignments keyed by identity.
    pub assignments: BTreeMap<String, AssignmentProjection>,
    /// Attempts keyed by identity.
    pub attempts: BTreeMap<String, AttemptProjection>,
}

/// Persistence port consumed by application use cases.
pub trait EventStore {
    /// Adapter-specific persistence error.
    type Error: std::error::Error;

    /// Commits one boundary and its projections atomically.
    fn append_boundary(&mut self, events: &[Event]) -> Result<usize, Self::Error>;

    /// Reads the current projected state.
    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error>;

    /// Reads a run's events in append order.
    fn load_events(&self, run_id: &str) -> Result<Vec<Event>, Self::Error>;

    /// Reconstructs state from ordered, authoritative events.
    fn replay_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error>;
}

/// Replays ordered events for a single run and rejects inconsistent histories.
pub fn replay(events: &[Event]) -> Result<Option<RunProjection>, String> {
    let mut run: Option<RunProjection> = None;
    for event in events {
        if event.event_id.trim().is_empty() || event.run_id.trim().is_empty() {
            return Err("empty event or run identifier".into());
        }
        if let EventKind::RunStarted { metadata } = &event.kind {
            if run.is_some()
                || metadata.adapter.trim().is_empty()
                || metadata.version.trim().is_empty()
            {
                return Err("duplicate run start or incomplete adapter metadata".into());
            }
            run = Some(RunProjection {
                run_id: event.run_id.clone(),
                status: RunStatus::Active,
                metadata: metadata.clone(),
                visits: Vec::new(),
                gates: BTreeMap::new(),
                assignments: BTreeMap::new(),
                attempts: BTreeMap::new(),
            });
            continue;
        }
        let state = run.as_mut().ok_or("event before run start")?;
        if state.run_id != event.run_id {
            return Err("mixed run identifiers".into());
        }
        match &event.kind {
            EventKind::RunStarted { .. } => unreachable!(),
            EventKind::RunSuspended if state.status == RunStatus::Active => {
                state.status = RunStatus::Suspended
            }
            EventKind::RunResumed if state.status == RunStatus::Suspended => {
                state.status = RunStatus::Active
            }
            EventKind::RunCompleted if state.status == RunStatus::Active => {
                state.status = RunStatus::Completed
            }
            EventKind::RunFailed
                if matches!(state.status, RunStatus::Active | RunStatus::Suspended) =>
            {
                state.status = RunStatus::Failed
            }
            EventKind::PhaseEntered {
                visit_id,
                phase,
                visit_number,
            }
            | EventKind::PhaseRevisited {
                visit_id,
                phase,
                visit_number,
            } => {
                if state.status != RunStatus::Active
                    || visit_id.trim().is_empty()
                    || phase.trim().is_empty()
                    || *visit_number == 0
                    || state.visits.iter().any(|v| v.visit_id == *visit_id)
                    || state
                        .visits
                        .last()
                        .is_some_and(|v| v.exited_at_ms.is_none())
                    || state.visits.iter().filter(|v| v.phase == *phase).count() + 1
                        != *visit_number as usize
                    || matches!(event.kind, EventKind::PhaseEntered { .. }) != (*visit_number == 1)
                {
                    return Err("invalid phase entry".into());
                }
                state.visits.push(VisitProjection {
                    visit_id: visit_id.clone(),
                    phase: phase.clone(),
                    visit_number: *visit_number,
                    entered_at_ms: event.occurred_at_ms,
                    exited_at_ms: None,
                    exit_gate_id: None,
                });
            }
            EventKind::PhaseExited {
                visit_id,
                phase,
                gate_id,
            } => {
                let visit = state.visits.last_mut().ok_or("phase exit before entry")?;
                if state.status != RunStatus::Active
                    || visit.visit_id != *visit_id
                    || visit.phase != *phase
                    || visit.exited_at_ms.is_some()
                    || event.occurred_at_ms < visit.entered_at_ms
                    || gate_id.trim().is_empty()
                    || !state
                        .gates
                        .get(gate_id)
                        .is_some_and(|gate| gate.passed && gate.visit_id == *visit_id)
                {
                    return Err("invalid phase exit".into());
                }
                visit.exited_at_ms = Some(event.occurred_at_ms);
                visit.exit_gate_id = Some(gate_id.clone());
            }
            EventKind::GateEvaluated {
                visit_id,
                gate_id,
                outcome,
            } => {
                if gate_id.trim().is_empty()
                    || state.gates.contains_key(gate_id)
                    || !state.visits.last().is_some_and(|visit| {
                        visit.visit_id == *visit_id && visit.exited_at_ms.is_none()
                    })
                {
                    return Err("gate references unknown or exited visit".into());
                }
                state.gates.insert(
                    gate_id.clone(),
                    GateProjection {
                        gate_id: gate_id.clone(),
                        visit_id: visit_id.clone(),
                        outcome: *outcome,
                        evaluated_at_ms: event.occurred_at_ms,
                        passed: false,
                    },
                );
            }
            EventKind::GatePassed { visit_id, gate_id } => {
                let gate = state
                    .gates
                    .get_mut(gate_id)
                    .ok_or("gate pass before evaluation")?;
                if gate.visit_id != *visit_id || gate.outcome != GateOutcome::Passed || gate.passed
                {
                    return Err("invalid gate pass".into());
                }
                gate.passed = true;
            }
            EventKind::AssignmentCreated {
                assignment_id,
                visit_id,
                role,
            } => {
                if assignment_id.trim().is_empty()
                    || role.trim().is_empty()
                    || state.assignments.contains_key(assignment_id)
                    || !state.visits.iter().any(|v| v.visit_id == *visit_id)
                {
                    return Err("invalid assignment".into());
                }
                state.assignments.insert(
                    assignment_id.clone(),
                    AssignmentProjection {
                        assignment_id: assignment_id.clone(),
                        visit_id: visit_id.clone(),
                        role: role.clone(),
                        outcome: None,
                    },
                );
            }
            EventKind::AssignmentCompleted {
                assignment_id,
                outcome,
            } => {
                let assignment = state
                    .assignments
                    .get_mut(assignment_id)
                    .ok_or("unknown assignment")?;
                if assignment.outcome.is_some() {
                    return Err("assignment already completed".into());
                }
                assignment.outcome = Some(*outcome);
            }
            EventKind::AttemptStarted {
                attempt_id,
                assignment_id,
            } => {
                if attempt_id.trim().is_empty()
                    || state.attempts.contains_key(attempt_id)
                    || !state.assignments.contains_key(assignment_id)
                {
                    return Err("invalid attempt".into());
                }
                state.attempts.insert(
                    attempt_id.clone(),
                    AttemptProjection {
                        attempt_id: attempt_id.clone(),
                        assignment_id: assignment_id.clone(),
                        started_at_ms: event.occurred_at_ms,
                        finished_at_ms: None,
                        outcome: None,
                    },
                );
            }
            EventKind::AttemptFinished {
                attempt_id,
                outcome,
            } => {
                let attempt = state
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or("unknown attempt")?;
                if attempt.outcome.is_some() || event.occurred_at_ms < attempt.started_at_ms {
                    return Err("attempt already finished or timestamp before start".into());
                }
                attempt.outcome = Some(*outcome);
                attempt.finished_at_ms = Some(event.occurred_at_ms);
            }
            _ => return Err("invalid run lifecycle transition".into()),
        }
    }
    Ok(run)
}
