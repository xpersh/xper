//! Pure domain concepts and deterministic rules.
//!
//! This crate must remain independent from I/O, persistence, command-line
//! interfaces, and harness SDKs.

/// Stable package identity used by scaffold-level dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::PACKAGE_NAME;

    #[test]
    fn exposes_the_domain_package_identity() {
        assert_eq!(PACKAGE_NAME, "xper-domain");
    }
}
