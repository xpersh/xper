use crate::{ArtifactId, GateId, PhaseVisitId, Timestamp};

/// A phase known to the xper workflow.
///
/// XP-003 only enables transitions between [`Phase::Intake`],
/// [`Phase::Discovery`], and [`Phase::Define`]. The remaining values make
/// unsupported transitions explicit without implementing the full workflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Phase {
    /// Establishes the request, authority, repository, and constraints.
    Intake,
    /// Investigates context, risks, hypotheses, and unknowns.
    Discovery,
    /// Establishes observable completion criteria and scope.
    Define,
    /// Selects the simplest viable design.
    Design,
    /// Divides the work into independently verifiable increments.
    Breakdown,
    /// Orders work, dependencies, roles, and budgets.
    Plan,
    /// Produces an increment with immediate feedback.
    Implementation,
    /// Checks acceptance, regression, and quality evidence.
    Verify,
    /// Makes the adversarial final acceptance decision.
    JudgmentDay,
    /// Records learning and closes the run.
    LearnClose,
}

/// Lifecycle state of a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunState {
    /// The run accepts workflow changes.
    Active,
    /// The run is temporarily suspended.
    Suspended,
    /// The run reached an explicit terminal result.
    Finished(RunResult),
}

/// Explicit terminal result of a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunResult {
    /// The intended workflow completed.
    Completed,
    /// The run ended because of a domain-level failure.
    Failed {
        /// Normalized reason the run failed.
        reason: String,
    },
    /// The run was cancelled deliberately.
    Cancelled,
    /// The run exceeded its time budget.
    TimedOut,
}

/// Lifecycle state of a phase visit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PhaseVisitState {
    /// This is the run's current visit.
    Active,
    /// The visit was exited after the identified gate passed.
    Exited {
        /// Time at which the visit ended.
        at: Timestamp,
        /// Gate that allowed the visit to end.
        gate_id: GateId,
    },
}

/// One concrete entry into a phase, including entries caused by revisits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhaseVisit {
    id: PhaseVisitId,
    phase: Phase,
    visit_number: u32,
    entered_at: Timestamp,
    state: PhaseVisitState,
}

impl PhaseVisit {
    pub(crate) fn enter(
        id: PhaseVisitId,
        phase: Phase,
        visit_number: u32,
        entered_at: Timestamp,
    ) -> Self {
        Self {
            id,
            phase,
            visit_number,
            entered_at,
            state: PhaseVisitState::Active,
        }
    }

    pub(crate) fn exit(&mut self, at: Timestamp, gate_id: GateId) {
        self.state = PhaseVisitState::Exited { at, gate_id };
    }

    /// Returns this visit's identity.
    #[must_use]
    pub fn id(&self) -> &PhaseVisitId {
        &self.id
    }

    /// Returns the visited phase.
    #[must_use]
    pub const fn phase(&self) -> Phase {
        self.phase
    }

    /// Returns the one-based number of visits to this phase in the run.
    #[must_use]
    pub const fn visit_number(&self) -> u32 {
        self.visit_number
    }

    /// Returns the entry time.
    #[must_use]
    pub const fn entered_at(&self) -> Timestamp {
        self.entered_at
    }

    /// Returns the visit's lifecycle state.
    #[must_use]
    pub const fn state(&self) -> &PhaseVisitState {
        &self.state
    }
}

/// Logical kind of a versioned artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactKind {
    /// Evidence and context produced by Discovery.
    DiscoveryBrief,
    /// Scope and acceptance contract produced by Define.
    DefinitionContract,
    /// A neutral extension point for later workflow artifacts.
    Other(String),
}

/// A logical reference to a versioned artifact without filesystem semantics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReference {
    id: ArtifactId,
    kind: ArtifactKind,
    version: u32,
}

impl ArtifactReference {
    /// Creates an artifact reference.
    #[must_use]
    pub const fn new(id: ArtifactId, kind: ArtifactKind, version: u32) -> Self {
        Self { id, kind, version }
    }

    /// Returns the artifact identity.
    #[must_use]
    pub const fn id(&self) -> &ArtifactId {
        &self.id
    }

    /// Returns the artifact kind.
    #[must_use]
    pub const fn kind(&self) -> &ArtifactKind {
        &self.kind
    }

    /// Returns the artifact version.
    #[must_use]
    pub const fn version(&self) -> u32 {
        self.version
    }
}

/// Result of evaluating an exit gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateResult {
    /// All conditions needed for the transition are satisfied.
    Passed,
    /// One or more conditions are not satisfied.
    Failed {
        /// Stable, caller-provided reasons for the failed evaluation.
        reasons: Vec<String>,
    },
    /// The gate cannot decide without a human choice.
    HumanDecisionRequired {
        /// Explanation of the choice that must be made.
        reason: String,
    },
}

/// Input used to evaluate the current phase's exit gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateEvaluation {
    name: String,
    result: GateResult,
    evidence: Vec<ArtifactReference>,
}

impl GateEvaluation {
    /// Creates a gate evaluation input.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        result: GateResult,
        evidence: Vec<ArtifactReference>,
    ) -> Self {
        Self {
            name: name.into(),
            result,
            evidence,
        }
    }

    /// Returns the stable gate name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the evaluated result.
    #[must_use]
    pub const fn result(&self) -> &GateResult {
        &self.result
    }

    /// Returns the evidence considered by the gate.
    #[must_use]
    pub fn evidence(&self) -> &[ArtifactReference] {
        &self.evidence
    }
}

/// A recorded gate evaluation tied to one phase visit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gate {
    id: GateId,
    phase_visit_id: PhaseVisitId,
    name: String,
    result: GateResult,
    evidence: Vec<ArtifactReference>,
    evaluated_at: Timestamp,
}

impl Gate {
    pub(crate) fn record(
        id: GateId,
        phase_visit_id: PhaseVisitId,
        evaluation: &GateEvaluation,
        evaluated_at: Timestamp,
    ) -> Self {
        Self {
            id,
            phase_visit_id,
            name: evaluation.name.clone(),
            result: evaluation.result.clone(),
            evidence: evaluation.evidence.clone(),
            evaluated_at,
        }
    }

    /// Returns the gate identity.
    #[must_use]
    pub const fn id(&self) -> &GateId {
        &self.id
    }

    /// Returns the phase visit evaluated by this gate.
    #[must_use]
    pub const fn phase_visit_id(&self) -> &PhaseVisitId {
        &self.phase_visit_id
    }

    /// Returns the stable gate name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the explicit gate result.
    #[must_use]
    pub const fn result(&self) -> &GateResult {
        &self.result
    }

    /// Returns the artifact evidence considered by the gate.
    #[must_use]
    pub fn evidence(&self) -> &[ArtifactReference] {
        &self.evidence
    }

    /// Returns when the gate was evaluated.
    #[must_use]
    pub const fn evaluated_at(&self) -> Timestamp {
        self.evaluated_at
    }
}
