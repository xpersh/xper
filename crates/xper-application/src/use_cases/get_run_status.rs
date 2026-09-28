//! Inspect reported state and timeline without changing execution outcomes.

use crate::{
    ApplicationError, events::RecordedEvent, ports::RunReader, read_models::RunProjection,
};

/// Which persisted recording to inspect.
pub enum Query<'a> {
    /// The most recently created recording in the workspace.
    Latest,
    /// A specific run, returning no projection when absent.
    Run(&'a str),
    /// The latest run belonging to the attached session, if any.
    Session(&'a str),
}

/// State and timeline built from recorded facts, without transport metadata.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The selected run, if present.
    pub run: Option<RunProjection>,
    /// Its events in append order.
    pub timeline: Vec<RecordedEvent>,
}

/// Reads the same status for command-line and bridge callers.
pub fn execute(store: &impl RunReader, query: Query<'_>) -> Result<Outcome, ApplicationError> {
    let run = match query {
        Query::Latest => store.latest_run().map_err(ApplicationError::dependency)?,
        Query::Run(id) => store.load_run(id).map_err(ApplicationError::dependency)?,
        Query::Session(id) => store
            .session_run(id)
            .map_err(ApplicationError::dependency)?
            .map(|run_id| store.load_run(&run_id))
            .transpose()
            .map_err(ApplicationError::dependency)?
            .flatten(),
    };
    let timeline = run
        .as_ref()
        .map(|run| store.load_events(&run.run_id))
        .transpose()
        .map_err(ApplicationError::dependency)?
        .unwrap_or_default();
    Ok(Outcome { run, timeline })
}
