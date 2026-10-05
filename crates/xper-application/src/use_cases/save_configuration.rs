//! Save reviewed scoped edits while guarding against external changes.

use crate::{
    ApplicationError,
    configuration::{
        ConfigurationChange, ConfigurationRepository, ConfigurationScope, ConfigurationSnapshot,
    },
};

/// Save reviewed scoped edits while guarding against external changes.
pub fn execute(
    repository: &mut impl ConfigurationRepository,
    snapshot: &ConfigurationSnapshot,
    scope: ConfigurationScope,
    changes: &[ConfigurationChange],
) -> Result<ConfigurationSnapshot, ApplicationError> {
    repository
        .save(snapshot, scope, changes)
        .map_err(ApplicationError::dependency)
}
