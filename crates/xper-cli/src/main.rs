//! The `xper` command-line entry point.

fn main() {}

#[cfg(test)]
mod tests {
    #[test]
    fn binary_is_named_xper() {
        assert_eq!(env!("CARGO_BIN_NAME"), "xper");
        assert_eq!(xper_application::DOMAIN_PACKAGE_NAME, "xper-domain");
        assert_eq!(xper_config::PACKAGE_NAME, "xper-config");
        assert_eq!(xper_protocol::PACKAGE_NAME, "xper-protocol");
        assert_eq!(xper_store_sqlite::PACKAGE_NAME, "xper-store-sqlite");
    }
}
