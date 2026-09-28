use std::{error::Error, fmt};

/// An opaque, non-empty identifier with no harness-specific semantics.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Identifier(String);

impl Identifier {
    /// Creates an identifier, rejecting empty or whitespace-only values.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidIdentifier> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidIdentifier);
        }
        Ok(Self(value))
    }

    /// Returns the identifier as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Identifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Error returned when an identifier is empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidIdentifier;

impl fmt::Display for InvalidIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("identifier must not be empty")
    }
}

impl Error for InvalidIdentifier {}
