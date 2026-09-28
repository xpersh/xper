//! Pure domain concepts and deterministic rules.
//!
//! This crate must remain independent from I/O, persistence, command-line
//! interfaces, and harness SDKs. Time and identifier allocation enter the
//! domain through [`Clock`] and [`IdGenerator`], so a caller can reproduce a
//! change exactly.

mod execution;
pub mod planning;
mod primitives;
mod run;
mod workflow;

pub use execution::{
    Assignment, AssignmentResult, AssignmentState, Attempt, AttemptResult, AttemptState,
};
pub use primitives::{
    ArtifactId, AssignmentId, AttemptId, Clock, EventId, GateId, IdGenerator, Identifier,
    InvalidIdentifier, PhaseVisitId, RequestId, RunId, Timestamp,
};
pub use run::{
    Change, DomainEvent, DomainEventKind, Run, TransitionError, TransitionReceipt,
    TransitionRequest, is_allowed_transition,
};
pub use workflow::{
    ArtifactKind, ArtifactReference, Gate, GateEvaluation, GateResult, Phase, PhaseVisit,
    PhaseVisitState, RunResult, RunState,
};

/// Stable package identity used by workspace dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::PACKAGE_NAME;

    #[test]
    fn exposes_the_domain_package_identity() {
        assert_eq!(PACKAGE_NAME, "xper-domain");
    }
}
