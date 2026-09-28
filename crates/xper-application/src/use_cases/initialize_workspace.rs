//! Prepare configuration only after installation preflight passes.

use crate::{
    ApplicationError,
    installation::{Check, CheckStatus},
    ports::Installation,
};

/// Result of initialization, including preflight rejection.
pub enum Outcome {
    /// Prerequisites must be repaired before initialization can proceed.
    Blocked,
    /// Preparation completed, possibly without changes on a repeated request.
    Completed {
        /// Descriptions of changes actually made by the installation adapter.
        changes: Vec<String>,
    },
}

/// Reports preflight diagnostics before allowing configuration writes.
pub fn execute(
    installation: &mut impl Installation,
    mut report: impl FnMut(&[Check]),
) -> Result<Outcome, ApplicationError> {
    let checks = installation.inspect();
    report(&checks);
    if checks.iter().any(|check| check.status == CheckStatus::Fail) {
        return Ok(Outcome::Blocked);
    }
    let changes = installation
        .prepare()
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome::Completed { changes })
}
