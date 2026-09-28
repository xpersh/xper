//! Record producer-reported facts without executing or authorizing a workflow.

use crate::{
    ApplicationError,
    events::{MAX_IDENTITY_BYTES, RecordedEvent},
    ports::RunRepository,
};
use xper_domain::Identifier;

/// A batch belonging to the explicitly attached adapter session.
pub struct Request<'a> {
    /// Session which owns this recording.
    pub session_id: &'a str,
    /// Nonempty observations for exactly one run.
    pub events: &'a [RecordedEvent],
}

/// Acknowledgement after the complete batch was committed.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Number of newly recorded events, excluding exact duplicate deliveries.
    pub accepted: usize,
}

/// Validates transport-neutral integrity and delegates one atomic append.
pub fn execute<R: RunRepository>(
    store: &mut R,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    validate_batch(request.session_id, request.events).map_err(ApplicationError::InvalidInput)?;
    let accepted = store
        .append_events(request.session_id, request.events)
        .map_err(|error| match R::invalid_input_message(&error) {
            Some(message) => ApplicationError::InvalidInput(message),
            None => ApplicationError::dependency(error),
        })?;
    Ok(Outcome { accepted })
}

/// Shared envelope validation for use cases and independently callable stores.
pub fn validate_batch(session_id: &str, events: &[RecordedEvent]) -> Result<(), &'static str> {
    if Identifier::new(session_id).is_err() {
        return Err("session ID must not be empty");
    }
    if session_id.len() > MAX_IDENTITY_BYTES {
        return Err("session ID must not exceed 256 UTF-8 bytes");
    }
    let first = events.first().ok_or("event batch must not be empty")?;
    for event in events {
        event.validate()?;
        if event.run_id != first.run_id {
            return Err("event batch must belong to one run");
        }
    }
    Ok(())
}
