//! Opaque identity validation has no workflow vocabulary.

use xper_domain::Identifier;

#[test]
fn identifiers_preserve_producer_labels_and_only_reject_blank_values() {
    for value in ["run/with spaces", "adapter:unknown", "123"] {
        assert_eq!(Identifier::new(value).unwrap().as_str(), value);
    }
    for value in ["", " ", "\t\n"] {
        assert!(Identifier::new(value).is_err());
    }
}
