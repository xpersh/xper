//! Browse recorded history without mutating or reconstructing execution policy.

use crate::{ApplicationError, ports::RunReader, read_models::RunPage};

/// Number of runs shown when callers do not select a page size.
pub const DEFAULT_LIMIT: usize = 50;
/// Maximum number of run projections requested in one query.
pub const MAX_LIMIT: usize = 100;

/// A bounded history query. Cursors are returned by a previous page.
#[derive(Clone, Copy, Debug)]
pub struct Query<'a> {
    /// Continue after this identity, or read the newest runs when absent.
    pub after: Option<&'a str>,
    /// Number of projections requested, between one and one hundred.
    pub limit: usize,
}

impl Default for Query<'_> {
    fn default() -> Self {
        Self {
            after: None,
            limit: DEFAULT_LIMIT,
        }
    }
}

/// Reads a history page through the inspection port.
pub fn execute(store: &impl RunReader, query: Query<'_>) -> Result<RunPage, ApplicationError> {
    if !(1..=MAX_LIMIT).contains(&query.limit) {
        return Err(ApplicationError::InvalidInput(
            "history limit must be between 1 and 100",
        ));
    }
    if query.after.is_some_and(|cursor| cursor.trim().is_empty()) {
        return Err(ApplicationError::InvalidInput(
            "history cursor must be nonempty",
        ));
    }
    store
        .list_runs(query.after, query.limit)
        .map_err(ApplicationError::dependency)
}
