//! The `xper` command-line entry point.

mod bridge;
mod composition;
mod infrastructure;
mod profile;
mod setup;
mod status;

use clap::{CommandFactory, Parser, Subcommand};
use std::io::IsTerminal;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "xper",
    version,
    about = "Extreme Programming workflow setup and diagnostics"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    /// Show plain help instead of opening the terminal dashboard.
    #[arg(long)]
    no_tui: bool,
    /// Use ASCII symbols in the terminal dashboard.
    #[arg(long)]
    ascii: bool,
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
        /// Inspect the user-wide Pi integration instead of this project.
        #[arg(long)]
        global: bool,
        /// Emit machine-readable JSON checks.
        #[arg(long)]
        json: bool,
    },
    /// Prepare xper in this project or in the global user scope.
    Init {
        /// Prepare the user-wide scope instead of this project.
        #[arg(long)]
        global: bool,
        /// Accepted for compatibility; initialization no longer needs confirmation.
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
        /// List recorded runs in this project, newest first.
        #[arg(long, conflicts_with = "run")]
        list: bool,
        /// Continue a history listing after the returned cursor.
        #[arg(long, requires = "list")]
        after: Option<String>,
        /// Maximum runs in one history page (1 through 100).
        #[arg(long, requires = "list")]
        limit: Option<usize>,
    },
    /// Activate or inspect an execution profile.
    Profile {
        #[command(subcommand)]
        action: ProfileAction,
    },
}

#[derive(Subcommand)]
enum ProfileAction {
    /// Select the profile for subsequent runs in this project.
    Activate { name: String },
    /// Show a profile and optionally every resolved role selection.
    Inspect {
        name: Option<String>,
        #[arg(long)]
        resolved: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        None if cli.no_tui
            || !std::io::stdin().is_terminal()
            || !std::io::stdout().is_terminal()
            || std::env::var("TERM").is_ok_and(|term| term == "dumb") =>
        {
            Cli::command().print_help().map(|()| {
                println!();
                true
            })
        }
        None => composition::dashboard(cli.ascii),
        Some(Commands::Bridge { stdio: true }) => bridge::run().map(|()| true),
        Some(Commands::Bridge { stdio: false }) => unreachable!("clap requires --stdio"),
        Some(Commands::Doctor { json, global }) => setup::doctor(json, global),
        Some(Commands::Init { global, yes: _ }) => setup::init(global),
        Some(Commands::Status {
            json,
            run,
            list,
            after,
            limit,
        }) => {
            if list {
                status::list(json, after.as_deref(), limit.unwrap_or(50))
            } else {
                status::show(json, run.as_deref())
            }
        }
        Some(Commands::Profile { action }) => match action {
            ProfileAction::Activate { name } => profile::activate(&name),
            ProfileAction::Inspect { name, resolved } => {
                profile::inspect(name.as_deref(), resolved)
            }
        },
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
