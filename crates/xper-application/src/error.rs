//! Failures exposed by use cases, independent of a transport or storage engine.

use std::{error::Error, fmt};

/// A rejected request or a failure in a dependency.
#[derive(Debug)]
pub enum ApplicationError {
    /// The requested operation cannot be applied to the current workflow.
    InvalidInput(&'static str),
    /// A dependency failed; the original error remains available as its source.
    Dependency(Box<dyn Error + Send + Sync>),
}

impl ApplicationError {
    pub(crate) fn dependency(error: impl Error + Send + Sync + 'static) -> Self {
        Self::Dependency(Box::new(error))
    }
}

impl fmt::Display for ApplicationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) => f.write_str(message),
            Self::Dependency(error) => error.fmt(f),
        }
    }
}

impl Error for ApplicationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidInput(_) => None,
            Self::Dependency(error) => Some(error.as_ref()),
        }
    }
}
