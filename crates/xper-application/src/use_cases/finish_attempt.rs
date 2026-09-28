//! Settle an attempt and register its phase evidence on success.

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
    /// Workspace-relative phase artifact path, required on success.
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
    let mut result = request.outcome;
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
        if existing == result
            || (existing == WorkOutcome::TimedOut && result == WorkOutcome::Succeeded)
        {
            return Ok(Outcome {
                attempt_id: attempt_id.into(),
                outcome: existing,
                artifact_id: None,
                replayed: true,
            });
        }
        return Err(ApplicationError::InvalidInput(
            "attempt already settled differently",
        ));
    }
    let assignment = &run.assignments[&attempt.assignment_id];
    let visit = run
        .visits
        .last()
        .ok_or(ApplicationError::InvalidInput("missing phase visit"))?;
    if assignment.visit_id != visit.visit_id {
        return Err(ApplicationError::InvalidInput(
            "attempt belongs to an earlier visit",
        ));
    }
    let phase = crate::policies::knowledge::phase(&run)?;
    if result == WorkOutcome::Succeeded
        && (clock
            .now()
            .as_millis()
            .saturating_sub(attempt.started_at_ms)
            >= run.policy.attempt_time_ms
            || clock
                .now()
                .as_millis()
                .saturating_sub(run.visits[0].entered_at_ms)
                >= run.policy.max_time_ms)
    {
        result = WorkOutcome::TimedOut;
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
        let expected = crate::policies::knowledge::output_path(phase, attempt_id);
        if relative != expected {
            return Err(ApplicationError::InvalidInput(
                "unexpected phase artifact path",
            ));
        }
        if !artifacts
            .is_available(relative)
            .map_err(ApplicationError::dependency)?
        {
            return Err(ApplicationError::InvalidInput(
                "phase artifact is missing or empty",
            ));
        }
        let digest = if phase == xper_domain::Phase::Discovery {
            artifacts
                .digest(relative)
                .map_err(ApplicationError::dependency)?
        } else {
            let (document, digest) = artifacts
                .read_contract(relative)
                .map_err(ApplicationError::dependency)?
                .ok_or(ApplicationError::InvalidInput(
                    "structured phase artifact required",
                ))?;
            crate::policies::knowledge::validate_inputs(
                &document,
                run.inputs
                    .get(&assignment.assignment_id)
                    .map_or(&[], Vec::as_slice),
            )
            .map_err(ApplicationError::InvalidInput)?;
            if document.output.kind() != phase.contract().expect("knowledge phase").1
                && document.output.kind() != "feedback"
            {
                return Err(ApplicationError::InvalidInput(
                    "artifact kind does not match the phase",
                ));
            }
            Some(digest)
        };
        let artifact_id = ids.next_id().as_str().to_owned();
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::ArtifactRegistered {
                artifact_id: artifact_id.clone(),
                attempt_id: attempt_id.into(),
                kind: phase.contract().expect("knowledge phase").1.into(),
                path: relative.into(),
                version: run
                    .artifacts
                    .values()
                    .filter(|a| a.kind == phase.contract().expect("knowledge phase").1)
                    .count() as u32
                    + 1,
            },
        ));
        if let Some(digest) = digest {
            events.push(event(
                clock,
                ids,
                &run.run_id,
                EventKind::ArtifactSealed {
                    artifact_id: artifact_id.clone(),
                    digest,
                },
            ));
        }
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
