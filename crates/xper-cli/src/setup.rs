//! Command-line presentation and user consent for installation use cases.

use crate::infrastructure::installation::LocalInstallation;
use serde_json::json;
use std::io::{self, IsTerminal, Write};
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

fn confirm(message: &str, yes: bool) -> io::Result<bool> {
    if yes {
        return Ok(true);
    }
    if !io::stdin().is_terminal() {
        return Ok(false);
    }
    eprint!("{message} [y/N] ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

pub(crate) fn doctor(json_output: bool) -> io::Result<bool> {
    let installation = LocalInstallation::current(false)?;
    let outcome = inspect_installation::execute(&installation);
    report(&outcome.checks, json_output);
    Ok(outcome.ready)
}

pub(crate) fn init(global: bool, yes: bool) -> io::Result<bool> {
    let mut installation = LocalInstallation::current(global)?;
    let outcome = initialize_workspace::execute(
        &mut installation,
        |checks| report(checks, false),
        |target| confirm(&format!("Create or repair {target}?"), yes),
    )
    .map_err(io::Error::other)?;
    match outcome {
        initialize_workspace::Outcome::Blocked => {
            eprintln!("init: resolve the failing preflight checks, then retry");
            Ok(false)
        }
        initialize_workspace::Outcome::ConfirmationRequired => {
            eprintln!("init: agent change needs confirmation; rerun with --yes");
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
