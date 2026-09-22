//! SQLite persistence infrastructure.

/// Stable package identity used by scaffold-level dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::PACKAGE_NAME;

    #[test]
    fn is_scaffolded_as_an_application_adapter() {
        assert_eq!(PACKAGE_NAME, "xper-store-sqlite");
        assert_eq!(xper_application::DOMAIN_PACKAGE_NAME, "xper-domain");
    }
}
