//! Application use cases and abstract ports.
//!
//! Implementations of persistence, clocks, workspaces, and harness execution
//! belong outside this crate.

/// Package identity of the only xper layer this scaffold depends on.
pub const DOMAIN_PACKAGE_NAME: &str = xper_domain::PACKAGE_NAME;

pub mod events;
pub mod slice;

#[cfg(test)]
mod tests {
    use super::DOMAIN_PACKAGE_NAME;

    #[test]
    fn depends_inward_on_the_domain() {
        assert_eq!(DOMAIN_PACKAGE_NAME, "xper-domain");
    }
}
