//! Installation orchestration without processes, files, or terminal input.

use std::convert::Infallible;
use xper_application::{
    installation::{Check, CheckStatus},
    ports::Installation,
    use_cases::{initialize_workspace, inspect_installation},
};

struct LocalSetup {
    blocked: bool,
    valid_agent: bool,
    preparations: Vec<bool>,
}
impl Installation for LocalSetup {
    type Error = Infallible;
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
                "AGENT",
                if self.valid_agent {
                    CheckStatus::Pass
                } else {
                    CheckStatus::Fail
                },
                "agent",
                None,
            )
            .repairable(),
        ]
    }
    fn agent_target(&self) -> String {
        "selected agent".into()
    }
    fn agent_is_valid(&self) -> Result<bool, Infallible> {
        Ok(self.valid_agent)
    }
    fn prepare(&mut self, repair_agent: bool) -> Result<Vec<String>, Infallible> {
        self.preparations.push(repair_agent);
        if repair_agent {
            self.valid_agent = true;
        }
        Ok(vec![])
    }
}

#[test]
fn failed_prerequisites_block_writes_and_do_not_request_consent() {
    let mut installation = LocalSetup {
        blocked: true,
        valid_agent: false,
        preparations: vec![],
    };
    assert!(!inspect_installation::execute(&installation).ready);
    let mut reported = false;
    let outcome = initialize_workspace::execute::<Infallible>(
        &mut installation,
        |checks| {
            assert_eq!(checks.len(), 2);
            reported = true;
        },
        |_| panic!("must not request consent after failed preflight"),
    )
    .unwrap();
    assert!(matches!(outcome, initialize_workspace::Outcome::Blocked));
    assert!(reported);
    assert!(installation.preparations.is_empty());
}

#[test]
fn declined_repair_does_not_write_any_installation_files() {
    let mut installation = LocalSetup {
        blocked: false,
        valid_agent: false,
        preparations: vec![],
    };
    let outcome = initialize_workspace::execute(
        &mut installation,
        |_| {},
        |target| {
            assert_eq!(target, "selected agent");
            Ok::<_, Infallible>(false)
        },
    )
    .unwrap();
    assert!(matches!(
        outcome,
        initialize_workspace::Outcome::ConfirmationRequired
    ));
    assert!(installation.preparations.is_empty());
}

#[test]
fn approved_repair_is_applied_and_valid_agents_need_no_consent() {
    let mut installation = LocalSetup {
        blocked: false,
        valid_agent: false,
        preparations: vec![],
    };
    let outcome =
        initialize_workspace::execute(&mut installation, |_| {}, |_| Ok::<_, Infallible>(true))
            .unwrap();
    assert!(matches!(
        outcome,
        initialize_workspace::Outcome::Completed { .. }
    ));
    assert_eq!(installation.preparations, [true]);
    assert!(inspect_installation::execute(&installation).ready);
    let outcome = initialize_workspace::execute::<Infallible>(
        &mut installation,
        |_| {},
        |_| panic!("valid agent needs no approval"),
    )
    .unwrap();
    assert!(matches!(
        outcome,
        initialize_workspace::Outcome::Completed { .. }
    ));
    assert_eq!(installation.preparations, [true, false]);
}
