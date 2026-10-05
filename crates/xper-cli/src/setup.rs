//! Command-line presentation for installation use cases.

use crate::infrastructure::installation::LocalInstallation;
use serde_json::json;
use std::io;
use xper_application::{
    installation::{Check, CheckStatus},
    use_cases::{initialize_workspace, inspect_installation},
};

fn status_name(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "PASS",
        CheckStatus::Warn => "WARN",
        CheckStatus::Fail => "FAIL",
    }
}

fn report(checks: &[Check], json_output: bool) {
    if json_output {
        let value = json!({"schemaVersion": 1, "checks": checks.iter().map(|check| json!({"id":check.id,"status":status_name(check.status),"evidence":check.evidence,"action":check.action})).collect::<Vec<_>>()});
        println!("{value}");
    } else {
        for check in checks {
            println!(
                "{}  {:<22} {}",
                status_name(check.status),
                check.id,
                check.evidence
            );
            if let Some(action) = &check.action {
                println!("      action: {action}");
            }
        }
    }
}

pub(crate) fn doctor(json_output: bool, global: bool) -> io::Result<bool> {
    let installation = LocalInstallation::current(global)?;
    let outcome = inspect_installation::execute(&installation);
    report(&outcome.checks, json_output);
    Ok(outcome.ready)
}

pub(crate) fn init(global: bool) -> io::Result<bool> {
    let mut installation = LocalInstallation::initialization(global)?;
    let outcome = initialize_workspace::execute(&mut installation, |checks| report(checks, false))
        .map_err(io::Error::other)?;
    match outcome {
        initialize_workspace::Outcome::Blocked => {
            eprintln!("init: resolve the failing preflight checks, then retry");
            Ok(false)
        }
        initialize_workspace::Outcome::Completed { changes } => {
            for change in changes {
                println!("{change}");
            }
            println!("init complete");
            Ok(true)
        }
    }
}
