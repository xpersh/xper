//! Dependencies required by configuration and passive recording use cases.

use crate::{events::RecordedEvent, installation::Check, read_models::RunProjection};

/// Read access to reported execution facts. Inspection requires no write access.
pub trait RunReader {
    /// Failure reported by the implementation.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Reads the observed projection of one run.
    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error>;

    /// Reads unchanged events in their authoritative append order.
    fn load_events(&self, run_id: &str) -> Result<Vec<RecordedEvent>, Self::Error>;

    /// Reads the most recently created recording in this workspace.
    fn latest_run(&self) -> Result<Option<RunProjection>, Self::Error>;

    /// Resolves the most recently created run belonging to a session.
    fn session_run(&self, session_id: &str) -> Result<Option<String>, Self::Error>;
}

/// Transactional append access; implementations enforce identity and ownership.
pub trait RunRepository: RunReader {
    /// Classifies integrity rejections separately from storage failures.
    fn invalid_input_message(_error: &Self::Error) -> Option<&'static str> {
        None
    }

    /// Atomically records a nonempty batch for one run and binds new runs to
    /// the supplied session. Exact duplicate events are ignored; conflicting
    /// IDs, foreign sessions, or invalid envelopes reject the complete batch.
    /// Returns the number of new events. Implementations never create outcomes.
    fn append_events(
        &mut self,
        session_id: &str,
        events: &[RecordedEvent],
    ) -> Result<usize, Self::Error>;
}

/// Installation inspection and preparation for one selected workspace scope.
pub trait Installation {
    /// Failure reported by local inspection or writes.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Reports requirements without modifying files or installing packages.
    fn inspect(&self) -> Vec<Check>;

    /// Applies idempotent configuration preparation after preflight passes.
    /// Preserves valid existing configuration and reports actual changes.
    fn prepare(&mut self) -> Result<Vec<String>, Self::Error>;
}
