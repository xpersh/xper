//! Preview and validate edits to one physical configuration scope.

use crate::{
    ApplicationError,
    configuration::{
        ConfigurationChange, ConfigurationPreview, ConfigurationRepository, ConfigurationScope,
        ConfigurationSnapshot,
    },
};

/// Preview and validate edits to one physical configuration scope.
pub fn execute(
    repository: &impl ConfigurationRepository,
    snapshot: &ConfigurationSnapshot,
    scope: ConfigurationScope,
    changes: &[ConfigurationChange],
) -> Result<ConfigurationPreview, ApplicationError> {
    repository
        .preview(snapshot, scope, changes)
        .map_err(ApplicationError::dependency)
}
