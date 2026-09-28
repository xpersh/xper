//! Read models derived from the durable event stream.

use crate::events::{AdapterMetadata, GateOutcome, ModelSelection, RoutingSnapshot, WorkOutcome};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

mod replay;
pub use replay::replay;

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
    /// One-based start order within the assignment.
    pub ordinal: u32,
    /// Exact model used, absent only for pre-routing histories.
    pub selection: Option<ModelSelection>,
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

/// A versioned artifact reference; content stays outside the event log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactProjection {
    /// Artifact identity.
    pub artifact_id: String,
    /// Attempt that produced the artifact.
    pub attempt_id: String,
    /// Stable artifact kind.
    pub kind: String,
    /// Path relative to the run workspace.
    pub path: String,
    /// One-based artifact version.
    pub version: u32,
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
    /// Effective routing captured at run start, absent for legacy runs.
    pub routing: Option<RoutingSnapshot>,
    /// Frozen run limits, defaulted for historical runs.
    #[serde(default)]
    pub policy: crate::knowledge::WorkflowPolicy,
    /// Frozen artifact inputs per logical assignment.
    #[serde(default)]
    pub inputs: BTreeMap<String, Vec<String>>,
    /// Conservative charged cost per attempt, retained on interruption.
    #[serde(default)]
    pub charges: BTreeMap<String, u64>,
    /// SHA-256 of registered evidence where supported by the artifact reader.
    #[serde(default)]
    pub seals: BTreeMap<String, String>,
    /// Accepted evidence on the current knowledge branch, keyed by phase.
    #[serde(default)]
    pub accepted: BTreeMap<String, String>,
    /// Artifact explaining the current revisit.
    #[serde(default)]
    pub feedback: Option<String>,
    /// Current human request as (visit, artifact).
    #[serde(default)]
    pub human_input: Option<(String, String)>,
    /// Visits in event order.
    pub visits: Vec<VisitProjection>,
    /// Gate evaluations keyed by identity.
    pub gates: BTreeMap<String, GateProjection>,
    /// Assignments keyed by identity.
    pub assignments: BTreeMap<String, AssignmentProjection>,
    /// Attempts keyed by identity.
    pub attempts: BTreeMap<String, AttemptProjection>,
    /// Registered artifact references keyed by identity.
    pub artifacts: BTreeMap<String, ArtifactProjection>,
}
