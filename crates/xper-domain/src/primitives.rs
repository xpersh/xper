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

macro_rules! identifier_type {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Identifier);

        impl $name {
            /// Returns the underlying opaque identifier.
            #[must_use]
            pub fn value(&self) -> &Identifier {
                &self.0
            }

            /// Returns the identifier as text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl From<Identifier> for $name {
            fn from(value: Identifier) -> Self {
                Self(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

identifier_type!(RunId, "Identity of one xper run.");
identifier_type!(PhaseVisitId, "Identity of one entry into a workflow phase.");
identifier_type!(AssignmentId, "Identity of a logical unit of assigned work.");
identifier_type!(
    AttemptId,
    "Identity of one execution attempt for an assignment."
);
identifier_type!(GateId, "Identity of one gate evaluation.");
identifier_type!(ArtifactId, "Identity of one versioned artifact.");
identifier_type!(EventId, "Identity of one domain event.");
identifier_type!(
    RequestId,
    "Idempotency identity of one requested domain change."
);

/// A timestamp expressed as milliseconds in an epoch chosen by the caller.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(u64);

impl Timestamp {
    /// Creates a timestamp from milliseconds.
    #[must_use]
    pub const fn from_millis(milliseconds: u64) -> Self {
        Self(milliseconds)
    }

    /// Returns the timestamp as milliseconds.
    #[must_use]
    pub const fn as_millis(self) -> u64 {
        self.0
    }
}

/// Supplies time to deterministic domain operations.
///
/// The domain never reads a system clock directly. Implementations may return
/// wall-clock or logical time as long as values use a consistent epoch.
pub trait Clock {
    /// Returns the current timestamp.
    fn now(&mut self) -> Timestamp;
}

/// Allocates opaque, harness-neutral identifiers for domain objects and events.
pub trait IdGenerator {
    /// Returns the next identifier in the generator's sequence.
    fn next_id(&mut self) -> Identifier;
}
