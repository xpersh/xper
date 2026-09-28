//! Command-line presentation of the run status query.

use std::io;

use serde_json::json;
use xper_application::use_cases::get_run_status;

use crate::composition::inspection_store;

pub(crate) fn show(json_output: bool, run_id: Option<&str>) -> io::Result<bool> {
    let root = std::env::current_dir()?;
    let status = match inspection_store(&root)? {
        Some(store) => get_run_status::execute(
            &store,
            run_id.map_or(get_run_status::Query::Latest, get_run_status::Query::Run),
        )
        .map_err(io::Error::other)?,
        None => get_run_status::Outcome::default(),
    };
    if run_id.is_some() && status.run.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unknown run ID",
        ));
    }
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"run":status.run,"timeline":status.timeline}))?
        );
    } else if let Some(run) = status.run {
        println!(
            "run {}: {}; phase {}; attempts {}/{} finished; events {}",
            run.run_id,
            run.status,
            run.phase.as_deref().unwrap_or("unknown"),
            run.metrics.attempts_finished,
            run.metrics.attempts_started,
            status.timeline.len()
        );
    } else {
        println!("no run in this project");
    }
    Ok(true)
}
