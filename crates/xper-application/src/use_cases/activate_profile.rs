//! Select a workspace profile or return to the configured default.

use crate::{
    ApplicationError,
    configuration::{ConfigurationRepository, ConfigurationSnapshot},
};

/// Select a workspace profile or return to the configured default.
pub fn execute(
    repository: &mut impl ConfigurationRepository,
    name: Option<&str>,
) -> Result<ConfigurationSnapshot, ApplicationError> {
    repository
        .activate(name)
        .map_err(ApplicationError::dependency)
}
