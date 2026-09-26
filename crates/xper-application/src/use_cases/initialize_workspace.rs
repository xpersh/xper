//! Prepare an installation only after preflight and any required agent approval.

use crate::{
    ApplicationError,
    installation::{Check, CheckStatus},
    ports::Installation,
};

/// Result of initialization, including preflight or consent rejection.
pub enum Outcome {
    /// Prerequisites must be repaired before initialization can proceed.
    Blocked,
    /// The agent needs changing and that change was not authorized.
    ConfirmationRequired,
    /// Preparation completed, possibly without changes on a repeated request.
    Completed {
        /// Descriptions of changes actually made by the installation adapter.
        changes: Vec<String>,
    },
}

/// The interface handles presentation and consent; the use case controls when
/// writes may happen. Both callbacks run only at their appropriate stage.
pub fn execute<E: std::error::Error + Send + Sync + 'static>(
    installation: &mut impl Installation,
    mut report: impl FnMut(&[Check]),
    mut confirm_agent: impl FnMut(&str) -> Result<bool, E>,
) -> Result<Outcome, ApplicationError> {
    let checks = installation.inspect();
    report(&checks);
    if checks
        .iter()
        .any(|check| check.status == CheckStatus::Fail && !check.repairable)
    {
        return Ok(Outcome::Blocked);
    }
    let repair_agent = !installation
        .agent_is_valid()
        .map_err(ApplicationError::dependency)?;
    if repair_agent
        && !confirm_agent(&installation.agent_target()).map_err(ApplicationError::dependency)?
    {
        return Ok(Outcome::ConfirmationRequired);
    }
    let changes = installation
        .prepare(repair_agent)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome::Completed { changes })
}
