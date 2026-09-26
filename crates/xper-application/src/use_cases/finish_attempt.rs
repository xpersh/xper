//! Settle an attempt and register its Discovery evidence on success.

use crate::{
    ApplicationError,
    events::{EventKind, WorkOutcome},
    ports::{ArtifactReader, Clock, IdGenerator, RunRepository},
};

use super::support::{active, event};

/// A normalized execution result from an attached session.
pub struct Request<'a> {
    /// Session that owns the attempt.
    pub session_id: &'a str,
    /// Attempt to settle.
    pub attempt_id: &'a str,
    /// Terminal result; interruption is reserved for recovery.
    pub outcome: WorkOutcome,
    /// Workspace-relative Discovery Brief path, required on success.
    pub artifact_path: Option<&'a str>,
}

/// Result of settling the attempt or replaying an identical terminal result.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Settled attempt.
    pub attempt_id: String,
    /// Recorded terminal result.
    pub outcome: WorkOutcome,
    /// Artifact registered by this call, if any.
    pub artifact_id: Option<String>,
    /// Whether the attempt already had this outcome.
    pub replayed: bool,
}

/// Validates evidence before committing the result, artifact and assignment.
pub fn execute(
    store: &mut impl RunRepository,
    artifacts: &impl ArtifactReader,
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    let attempt_id = request.attempt_id;
    let result = request.outcome;
    if result == WorkOutcome::Interrupted {
        return Err(ApplicationError::InvalidInput(
            "interruption is reserved for recovery",
        ));
    }
    let run = active(store, request.session_id)?;
    let attempt = run
        .attempts
        .get(attempt_id)
        .ok_or(ApplicationError::InvalidInput("unknown attempt"))?;
    if let Some(existing) = attempt.outcome {
        if existing == result {
            return Ok(Outcome {
                attempt_id: attempt_id.into(),
                outcome: result,
                artifact_id: None,
                replayed: true,
            });
        }
        return Err(ApplicationError::InvalidInput(
            "attempt already settled differently",
        ));
    }
    let mut events = vec![event(
        clock,
        ids,
        &run.run_id,
        EventKind::AttemptFinished {
            attempt_id: attempt_id.into(),
            outcome: result,
        },
    )];
    let artifact_id = if result == WorkOutcome::Succeeded {
        let relative = request
            .artifact_path
            .filter(|path| !path.trim().is_empty())
            .ok_or(ApplicationError::InvalidInput(
                "missing or empty workflow parameter",
            ))?;
        let expected = format!(".xper/artifacts/discovery-brief-{attempt_id}.md");
        if relative != expected {
            return Err(ApplicationError::InvalidInput(
                "unexpected Discovery Brief path",
            ));
        }
        if !artifacts
            .is_available(relative)
            .map_err(ApplicationError::dependency)?
        {
            return Err(ApplicationError::InvalidInput(
                "Discovery Brief is missing or empty",
            ));
        }
        let artifact_id = ids.next_id().as_str().to_owned();
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::ArtifactRegistered {
                artifact_id: artifact_id.clone(),
                attempt_id: attempt_id.into(),
                kind: "discovery_brief".into(),
                path: relative.into(),
                version: 1,
            },
        ));
        Some(artifact_id)
    } else {
        None
    };
    events.push(event(
        clock,
        ids,
        &run.run_id,
        EventKind::AssignmentCompleted {
            assignment_id: attempt.assignment_id.clone(),
            outcome: result,
        },
    ));
    store
        .append_boundary(&events)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome {
        attempt_id: attempt_id.into(),
        outcome: result,
        artifact_id,
        replayed: false,
    })
}
