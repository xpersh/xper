use crate::{ArtifactReference, AssignmentId, AttemptId, PhaseVisitId};

/// Lifecycle state of a logical assignment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssignmentState {
    /// The assignment has not started.
    Pending,
    /// At least one attempt is actively working on the assignment.
    Active,
    /// The assignment reached an explicit terminal result.
    Finished(AssignmentResult),
}

/// Explicit terminal result of an assignment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssignmentResult {
    /// The assignment completed and produced the referenced artifacts.
    Succeeded {
        /// Outputs that satisfy the assignment.
        artifacts: Vec<ArtifactReference>,
    },
    /// The assignment failed without a usable result.
    Failed {
        /// Normalized reason the assignment failed.
        reason: String,
    },
    /// The assignment was cancelled deliberately.
    Cancelled,
    /// The assignment exceeded its time budget.
    TimedOut,
}

/// A logical unit of work assigned to a neutral role name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assignment {
    id: AssignmentId,
    phase_visit_id: PhaseVisitId,
    role: String,
    state: AssignmentState,
}

impl Assignment {
    /// Creates an assignment representation with an explicit state.
    #[must_use]
    pub fn new(
        id: AssignmentId,
        phase_visit_id: PhaseVisitId,
        role: impl Into<String>,
        state: AssignmentState,
    ) -> Self {
        Self {
            id,
            phase_visit_id,
            role: role.into(),
            state,
        }
    }

    /// Returns the assignment identity.
    #[must_use]
    pub fn id(&self) -> &AssignmentId {
        &self.id
    }

    /// Returns the visit that owns the assignment.
    #[must_use]
    pub fn phase_visit_id(&self) -> &PhaseVisitId {
        &self.phase_visit_id
    }

    /// Returns the harness-neutral role name.
    #[must_use]
    pub fn role(&self) -> &str {
        &self.role
    }

    /// Returns the assignment state.
    #[must_use]
    pub const fn state(&self) -> &AssignmentState {
        &self.state
    }
}

/// Lifecycle state of a concrete attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptState {
    /// The attempt has been defined but not started.
    Pending,
    /// The attempt is currently executing.
    Running,
    /// The attempt reached an explicit terminal result.
    Finished(AttemptResult),
}

/// Explicit terminal result of an attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptResult {
    /// The attempt settled successfully with the referenced artifacts.
    Succeeded {
        /// Outputs created by the attempt.
        artifacts: Vec<ArtifactReference>,
    },
    /// The attempt failed with a normalized domain reason.
    Failed {
        /// Normalized reason the attempt failed.
        reason: String,
    },
    /// The attempt was cancelled deliberately.
    Cancelled,
    /// The attempt exceeded its time budget.
    TimedOut,
}

/// One concrete execution attempt for an assignment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    id: AttemptId,
    assignment_id: AssignmentId,
    state: AttemptState,
}

impl Attempt {
    /// Creates an attempt representation with an explicit state.
    #[must_use]
    pub const fn new(id: AttemptId, assignment_id: AssignmentId, state: AttemptState) -> Self {
        Self {
            id,
            assignment_id,
            state,
        }
    }

    /// Returns the attempt identity.
    #[must_use]
    pub const fn id(&self) -> &AttemptId {
        &self.id
    }

    /// Returns the assignment attempted.
    #[must_use]
    pub const fn assignment_id(&self) -> &AssignmentId {
        &self.assignment_id
    }

    /// Returns the attempt state.
    #[must_use]
    pub const fn state(&self) -> &AttemptState {
        &self.state
    }
}
