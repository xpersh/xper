//! Create a Discovery assignment and attempt, or retry a pending assignment.

use crate::{
    ApplicationError,
    events::EventKind,
    ports::{Clock, IdGenerator, RunRepository},
};

use super::support::{active, event};

/// Intent to delegate Discovery work in one session.
pub struct Request<'a> {
    /// Session whose run receives the work.
    pub session_id: &'a str,
    /// Pending assignment to retry; absent for a new logical assignment.
    pub retry_assignment_id: Option<&'a str>,
}

/// Identities the caller uses to dispatch and correlate execution.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Owning run.
    pub run_id: String,
    /// Logical assignment.
    pub assignment_id: String,
    /// Physical execution attempt.
    pub attempt_id: String,
    /// Harness-neutral role to execute.
    pub role: &'static str,
}

/// Records the assignment and attempt together before execution is dispatched.
pub fn execute(
    store: &mut impl RunRepository,
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    let run = active(store, request.session_id)?;
    let visit = run
        .visits
        .last()
        .ok_or(ApplicationError::InvalidInput("run has no visit"))?;
    if visit.phase != "discovery" {
        return Err(ApplicationError::InvalidInput("Discovery is not active"));
    }
    let pending = request
        .retry_assignment_id
        .map(|id| {
            run.assignments
                .get(id)
                .filter(|assignment| {
                    assignment.visit_id == visit.visit_id && assignment.outcome.is_none()
                })
                .ok_or(ApplicationError::InvalidInput(
                    "assignment is not pending in this Discovery visit",
                ))
        })
        .transpose()?;
    if let Some(assignment) = pending
        && run.attempts.values().any(|attempt| {
            attempt.assignment_id == assignment.assignment_id && attempt.outcome.is_none()
        })
    {
        return Err(ApplicationError::InvalidInput(
            "assignment already has a running attempt",
        ));
    }
    let assignment_id = pending.map_or_else(
        || ids.next_id().as_str().to_owned(),
        |assignment| assignment.assignment_id.clone(),
    );
    let attempt_id = ids.next_id().as_str().to_owned();
    let role = "discovery.explorer";
    let mut events = Vec::new();
    if pending.is_none() {
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::AssignmentCreated {
                assignment_id: assignment_id.clone(),
                visit_id: visit.visit_id.clone(),
                role: role.into(),
            },
        ));
    }
    events.push(event(
        clock,
        ids,
        &run.run_id,
        EventKind::AttemptStarted {
            attempt_id: attempt_id.clone(),
            assignment_id: assignment_id.clone(),
        },
    ));
    store
        .append_boundary(&events)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome {
        run_id: run.run_id,
        assignment_id,
        attempt_id,
        role,
    })
}
