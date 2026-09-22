//! Configuration loading and validation infrastructure.

/// Stable package identity used by scaffold-level dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::PACKAGE_NAME;

    #[test]
    fn is_scaffolded_as_a_distinct_infrastructure_crate() {
        assert_eq!(PACKAGE_NAME, "xper-config");
        assert_eq!(xper_application::DOMAIN_PACKAGE_NAME, "xper-domain");
    }
}
