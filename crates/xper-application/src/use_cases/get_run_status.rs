//! Inspect persisted state and timeline without mutating the workflow.

use crate::{ApplicationError, events::Event, ports::RunReader, read_models::RunProjection};

use super::support::current;

/// Which persisted run to inspect.
pub enum Query<'a> {
    /// The most recently started run in the workspace.
    Latest,
    /// A specific run, failing if it does not exist.
    Run(&'a str),
    /// The run bound to an attached session, if any.
    Session(&'a str),
}

/// State and timeline built from persisted data, without transport metadata.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The selected run, if present.
    pub run: Option<RunProjection>,
    /// Its events in append order.
    pub timeline: Vec<Event>,
}

/// Reads the same status for command-line and bridge callers.
pub fn execute(store: &impl RunReader, query: Query<'_>) -> Result<Outcome, ApplicationError> {
    let run = match query {
        Query::Latest => store.latest_run().map_err(ApplicationError::dependency)?,
        Query::Run(id) => Some(
            store
                .load_run(id)
                .map_err(ApplicationError::dependency)?
                .ok_or(ApplicationError::InvalidInput("unknown run ID"))?,
        ),
        Query::Session(id) => current(store, id)?,
    };
    let timeline = run
        .as_ref()
        .map(|run| store.load_events(&run.run_id))
        .transpose()
        .map_err(ApplicationError::dependency)?
        .unwrap_or_default();
    Ok(Outcome { run, timeline })
}
