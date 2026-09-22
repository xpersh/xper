//! Public, language-neutral protocol boundary for harness adapters.

/// Stable package identity used by scaffold-level contract smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::PACKAGE_NAME;

    #[test]
    fn exposes_the_public_protocol_package_identity() {
        assert_eq!(PACKAGE_NAME, "xper-protocol");
    }
}
