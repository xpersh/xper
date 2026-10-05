//! Inspect configuration sources and effective values.

use crate::{
    ApplicationError,
    configuration::{ConfigurationRepository, ConfigurationSnapshot},
};

/// Inspect configuration sources and effective values.
pub fn execute(
    repository: &impl ConfigurationRepository,
) -> Result<ConfigurationSnapshot, ApplicationError> {
    repository.inspect().map_err(ApplicationError::dependency)
}
