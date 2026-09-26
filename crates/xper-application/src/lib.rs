//! Application use cases and abstract ports.
//!
//! Implementations of persistence, clocks, workspaces, and harness execution
//! belong outside this crate.

/// Package identity of the domain layer this crate depends on.
pub const DOMAIN_PACKAGE_NAME: &str = xper_domain::PACKAGE_NAME;

pub mod error;
pub mod events;
pub mod installation;
mod policies;
pub mod ports;
pub mod read_models;
pub mod use_cases;

pub use error::ApplicationError;
