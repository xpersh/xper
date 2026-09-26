//! Dependencies required by workflow use cases, implemented by outer layers.

use crate::{events::Event, installation::Check, read_models::RunProjection};

pub use xper_domain::{Clock, IdGenerator};

/// Read access to persisted workflow state. Inspection needs no write access.
pub trait RunReader {
    /// Failure reported by the implementation.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Reads the current projected state of one run.
    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error>;

    /// Reads events in their authoritative append order.
    fn load_events(&self, run_id: &str) -> Result<Vec<Event>, Self::Error>;

    /// Reads the most recently started run in this workspace.
    fn latest_run(&self) -> Result<Option<RunProjection>, Self::Error>;

    /// Resolves the run bound to a harness-neutral session key.
    fn session_run(&self, session_id: &str) -> Result<Option<String>, Self::Error>;
}

/// Transactional writes required by workflow commands.
pub trait RunRepository: RunReader {
    /// Commits a complete boundary and its projections atomically.
    fn append_boundary(&mut self, events: &[Event]) -> Result<usize, Self::Error>;

    /// Commits a run's initial events and session binding in one transaction.
    /// Failure must leave neither a partial run nor a session binding behind.
    fn append_boundary_and_bind_session(
        &mut self,
        events: &[Event],
        session_id: &str,
        run_id: &str,
    ) -> Result<usize, Self::Error>;
}

/// Evidence availability without exposing filesystem APIs to use cases.
pub trait ArtifactReader {
    /// Failure reported by the implementation.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Whether a workspace-relative artifact is a nonempty file.
    fn is_available(&self, path: &str) -> Result<bool, Self::Error>;
}

/// Installation inspection and preparation for one selected workspace scope.
pub trait Installation {
    /// Failure reported by local inspection or writes.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Reports requirements without modifying files or installing packages.
    fn inspect(&self) -> Vec<Check>;

    /// Human-readable destination for a potential agent change.
    fn agent_target(&self) -> String;

    /// Whether the selected scope already contains a valid agent definition.
    fn agent_is_valid(&self) -> Result<bool, Self::Error>;

    /// Applies idempotent preparation after preflight and any required approval.
    /// Preserve valid files and check backup conflicts before writing anything.
    /// Returns descriptions of the changes actually made.
    fn prepare(&mut self, repair_agent: bool) -> Result<Vec<String>, Self::Error>;
}
