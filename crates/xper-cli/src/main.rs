//! The `xper` command-line entry point.

mod bridge;
mod composition;
mod infrastructure;
mod setup;
mod status;

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "xper",
    version,
    about = "Extreme Programming workflow setup and diagnostics"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the bridge over standard input and output.
    Bridge {
        /// Use JSONL over standard input and output.
        #[arg(long, required = true)]
        stdio: bool,
    },
    /// Inspect the installation without modifying it.
    Doctor {
        /// Emit machine-readable JSON checks.
        #[arg(long)]
        json: bool,
    },
    /// Prepare xper in this project or in the global user scope.
    Init {
        /// Prepare the user-wide scope instead of this project.
        #[arg(long)]
        global: bool,
        /// Confirm agent creation or repair in non-interactive use.
        #[arg(long)]
        yes: bool,
    },
    /// Show the latest project run and its persisted timeline.
    Status {
        /// Emit the full JSON projection and timeline.
        #[arg(long)]
        json: bool,
        /// Inspect a specific run when several sessions share the project.
        #[arg(long)]
        run: Option<String>,
    },
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        Commands::Bridge { stdio: true } => bridge::run().map(|()| true),
        Commands::Bridge { stdio: false } => unreachable!("clap requires --stdio"),
        Commands::Doctor { json } => setup::doctor(json),
        Commands::Init { global, yes } => setup::init(global, yes),
        Commands::Status { json, run } => status::show(json, run.as_deref()),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("xper: {error}");
            ExitCode::FAILURE
        }
    }
}
