//! Configuration support and passive recording use cases with explicit ports.

/// Package identity of the domain layer this crate depends on.
pub const DOMAIN_PACKAGE_NAME: &str = xper_domain::PACKAGE_NAME;

pub mod configuration;
pub mod error;
pub mod events;
pub mod installation;
pub mod ports;
pub mod read_models;
pub mod use_cases;

pub use error::ApplicationError;
