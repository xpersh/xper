//! Inspect the selected installation without making changes.

use crate::{
    installation::{Check, CheckStatus},
    ports::Installation,
};

/// Diagnostics and the resulting readiness of the installation.
pub struct Outcome {
    /// Checks in adapter-defined presentation order.
    pub checks: Vec<Check>,
    /// Whether no check failed.
    pub ready: bool,
}

/// Runs the installation adapter's checks and evaluates overall readiness.
pub fn execute(installation: &impl Installation) -> Outcome {
    let checks = installation.inspect();
    let ready = !checks.iter().any(|check| check.status == CheckStatus::Fail);
    Outcome { checks, ready }
}
