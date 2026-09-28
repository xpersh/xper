//! Harness-neutral, privacy-bounded durable event vocabulary.

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

/// Exact, harness-neutral model chosen for one physical attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelection {
    /// Policy context for this execution; credentials remain Pi-owned.
    pub context: String,
    /// Exact provider identifier.
    pub provider: String,
    /// Exact model identifier.
    pub model: String,
    /// Exact requested thinking level.
    pub thinking: String,
}

/// Frozen model selection for each role in a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingSnapshot {
    /// Execution profile active at run start.
    pub profile: String,
    /// Fixed context for the run.
    pub context: String,
    /// Resolved selections by role, preserving the event payload shape.
    pub routes: BTreeMap<String, Vec<ModelSelection>>,
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
    pub fn from_domain(
        event: &DomainEvent,
        metadata: &AdapterMetadata,
        routing: Option<&RoutingSnapshot>,
    ) -> Self {
        let kind = match event.kind() {
            DomainEventKind::RunStarted { .. } => EventKind::RunStarted {
                metadata: metadata.clone(),
                routing: routing.cloned(),
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        routing: Option<RoutingSnapshot>,
    },
    FeedbackRecorded {
        artifact_id: String,
    },
    WorkflowConfigured {
        policy: crate::knowledge::WorkflowPolicy,
    },
    AssignmentInputs {
        assignment_id: String,
        artifact_ids: Vec<String>,
    },
    AttemptCharged {
        attempt_id: String,
        cost_micros: u64,
    },
    ArtifactSealed {
        artifact_id: String,
        digest: String,
    },
    PhaseAccepted {
        visit_id: String,
        artifact_id: String,
    },
    HumanInputRequested {
        visit_id: String,
        artifact_id: String,
    },
    HumanApproved {
        visit_id: String,
        artifact_id: String,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selection: Option<ModelSelection>,
    },
    AttemptFinished {
        attempt_id: String,
        outcome: WorkOutcome,
    },
    ArtifactRegistered {
        artifact_id: String,
        attempt_id: String,
        kind: String,
        path: String,
        version: u32,
    },
}

impl EventKind {
    /// Stable type name stored outside the JSON payload for indexing.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run.started",
            Self::FeedbackRecorded { .. } => "feedback.recorded",
            Self::WorkflowConfigured { .. } => "workflow.configured",
            Self::AssignmentInputs { .. } => "assignment.inputs",
            Self::AttemptCharged { .. } => "attempt.charged",
            Self::ArtifactSealed { .. } => "artifact.sealed",
            Self::PhaseAccepted { .. } => "phase.accepted",
            Self::HumanInputRequested { .. } => "human.input_requested",
            Self::HumanApproved { .. } => "human.approved",
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
            Self::ArtifactRegistered { .. } => "artifact.registered",
        }
    }
}
