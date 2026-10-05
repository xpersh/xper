//! Command-line presentation of the run status query.

use std::io;

use serde_json::json;
use xper_application::{
    read_models::RunPage,
    use_cases::{get_run_status, list_runs},
};

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

pub(crate) fn list(json_output: bool, after: Option<&str>, limit: usize) -> io::Result<bool> {
    let root = std::env::current_dir()?;
    if !(1..=list_runs::MAX_LIMIT).contains(&limit) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "history limit must be between 1 and 100",
        ));
    }
    let page = match inspection_store(&root)? {
        Some(store) => list_runs::execute(&store, list_runs::Query { after, limit })
            .map_err(io::Error::other)?,
        None if after.is_some() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown history cursor",
            ));
        }
        None => RunPage::default(),
    };
    if json_output {
        println!("{}", serde_json::to_string_pretty(&page)?);
    } else if page.runs.is_empty() {
        println!("no runs in this project");
    } else {
        for run in page.runs {
            println!(
                "run {}: {}; phase {}; attempts {}/{} finished; last observation {}",
                run.run_id,
                run.status,
                run.phase.as_deref().unwrap_or("unknown"),
                run.metrics.attempts_finished,
                run.metrics.attempts_started,
                run.last_event_at,
            );
        }
        if let Some(cursor) = page.next_cursor {
            println!(
                "more history: use --after {}",
                serde_json::to_string(&cursor)?
            );
        }
    }
    Ok(true)
}
