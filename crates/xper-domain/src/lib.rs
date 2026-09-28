//! Harness-neutral recording primitives, without execution policy or I/O.

mod primitives;

pub use primitives::{Identifier, InvalidIdentifier};

/// Stable package identity used by workspace dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");
