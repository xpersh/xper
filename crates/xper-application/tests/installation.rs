//! Installation orchestration without processes, files, or terminal input.

use std::io;
use xper_application::{
    ApplicationError,
    installation::{Check, CheckStatus},
    ports::Installation,
    use_cases::{initialize_workspace, inspect_installation},
};

struct LocalSetup {
    blocked: bool,
    fail_preparation: bool,
    preparations: usize,
}

impl Installation for LocalSetup {
    type Error = io::Error;

    fn inspect(&self) -> Vec<Check> {
        vec![
            Check::new(
                "RUNTIME",
                if self.blocked {
                    CheckStatus::Fail
                } else {
                    CheckStatus::Pass
                },
                "runtime",
                None,
            ),
            Check::new(
                "CONFIG",
                CheckStatus::Warn,
                "configuration not prepared",
                Some("Run initialization"),
            ),
        ]
    }

    fn prepare(&mut self) -> io::Result<Vec<String>> {
        self.preparations += 1;
        if self.fail_preparation {
            return Err(io::Error::other("configuration write failed"));
        }
        Ok(vec!["Created configuration".into()])
    }
}

#[test]
fn inspection_reports_readiness_without_preparing_configuration() {
    let installation = LocalSetup {
        blocked: false,
        fail_preparation: false,
        preparations: 0,
    };
    let outcome = inspect_installation::execute(&installation);
    assert!(outcome.ready);
    assert_eq!(outcome.checks.len(), 2);
    assert_eq!(installation.preparations, 0);
}

#[test]
fn failed_prerequisites_are_reported_and_block_writes() {
    let mut installation = LocalSetup {
        blocked: true,
        fail_preparation: false,
        preparations: 0,
    };
    assert!(!inspect_installation::execute(&installation).ready);
    let mut reported = false;
    let outcome = initialize_workspace::execute(&mut installation, |checks| {
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].status, CheckStatus::Fail);
        reported = true;
    })
    .unwrap();
    assert!(matches!(outcome, initialize_workspace::Outcome::Blocked));
    assert!(reported);
    assert_eq!(installation.preparations, 0);
}

#[test]
fn warnings_allow_configuration_preparation_without_confirmation() {
    let mut installation = LocalSetup {
        blocked: false,
        fail_preparation: false,
        preparations: 0,
    };
    let mut reported = false;
    let outcome = initialize_workspace::execute(&mut installation, |checks| {
        assert_eq!(checks[1].status, CheckStatus::Warn);
        reported = true;
    })
    .unwrap();
    let initialize_workspace::Outcome::Completed { changes } = outcome else {
        panic!("warnings must not block initialization");
    };
    assert_eq!(changes, ["Created configuration"]);
    assert!(reported);
    assert_eq!(installation.preparations, 1);
}

#[test]
fn preparation_failure_preserves_the_dependency_error() {
    let mut installation = LocalSetup {
        blocked: false,
        fail_preparation: true,
        preparations: 0,
    };
    let outcome = initialize_workspace::execute(&mut installation, |_| {});
    let Err(ApplicationError::Dependency(error)) = outcome else {
        panic!("preparation failure must be reported as a dependency error");
    };
    assert_eq!(error.to_string(), "configuration write failed");
    assert_eq!(installation.preparations, 1);
}
