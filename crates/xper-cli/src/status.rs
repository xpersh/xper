//! Command-line presentation of the run status query.

use std::io;

use serde_json::json;
use xper_application::{events::WorkOutcome, use_cases::get_run_status};

use crate::composition::inspection_store;

pub(crate) fn show(json_output: bool, run_id: Option<&str>) -> io::Result<bool> {
    let root = std::env::current_dir()?;
    let status = match inspection_store(&root)? {
        Some(store) => get_run_status::execute(
            &store,
            run_id.map_or(get_run_status::Query::Latest, get_run_status::Query::Run),
        )
        .map_err(io::Error::other)?,
        None if run_id.is_some() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown run ID",
            ));
        }
        None => get_run_status::Outcome::default(),
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"run":status.run,"timeline":status.timeline}))?
        );
    } else if let Some(run) = status.run {
        let phase = run.visits.last().map_or("?", |visit| visit.phase.as_str());
        let attempts = run
            .attempts
            .values()
            .map(|attempt| match attempt.outcome {
                None => "running",
                Some(WorkOutcome::Succeeded) => "succeeded",
                Some(WorkOutcome::Failed) => "failed",
                Some(WorkOutcome::Cancelled) => "cancelled",
                Some(WorkOutcome::TimedOut) => "timed_out",
                Some(WorkOutcome::Interrupted) => "interrupted",
            })
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "run {}: {phase}; attempts {attempts}; briefs {}; events {}",
            run.run_id,
            run.artifacts.len(),
            status.timeline.len()
        );
    } else {
        println!("no run in this project");
    }
    Ok(true)
}
