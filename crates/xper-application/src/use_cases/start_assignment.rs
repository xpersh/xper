//! Dispatch one knowledge assignment from frozen artifact inputs.

use crate::{
    ApplicationError,
    events::{EventKind, ModelSelection},
    ports::{ArtifactReader, Clock, IdGenerator, RunRepository},
};

use super::support::{active, event};

/// Intent to delegate the current knowledge phase in one session.
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
    /// Active knowledge phase.
    pub phase: &'static str,
    /// Required output kind and immutable output location.
    pub artifact_kind: &'static str,
    /// Workspace-relative output path.
    pub artifact_path: String,
    /// Input artifact identities and paths; never a transcript.
    pub input_artifacts: Vec<crate::read_models::ArtifactProjection>,
    /// Effective timeout, bounded by the remaining run time.
    pub timeout_ms: u64,
    /// Remaining run limits after this dispatch.
    pub budget: crate::knowledge::RemainingBudget,
    /// Exact selection to pass to the harness, if routing is configured.
    pub selection: Option<ModelSelection>,
}

/// Records the assignment and attempt together before execution is dispatched.
pub fn execute(
    store: &mut impl RunRepository,
    artifacts: &impl ArtifactReader,
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    let run = active(store, request.session_id)?;
    let visit = run
        .visits
        .last()
        .ok_or(ApplicationError::InvalidInput("run has no visit"))?;
    let phase = crate::policies::knowledge::phase(&run)?;
    if run.accepted.contains_key("plan") {
        return Err(ApplicationError::InvalidInput(
            "execution plan is ready; implementation is not available",
        ));
    }
    let (role, artifact_kind) = phase.contract().expect("knowledge phase");
    let now = clock.now().as_millis();
    let elapsed = now.saturating_sub(run.visits.first().expect("visit").entered_at_ms);
    run.policy
        .budget()
        .check(
            run.attempts.len(),
            run.attempts
                .values()
                .filter(|a| a.outcome.is_none())
                .count(),
            elapsed,
            run.charges
                .values()
                .fold(0u64, |sum, c| sum.saturating_add(*c)),
        )
        .map_err(ApplicationError::InvalidInput)?;
    let charged = run
        .charges
        .values()
        .fold(0u64, |sum, c| sum.saturating_add(*c))
        .saturating_add(run.policy.attempt_cost_micros);
    let budget = crate::knowledge::RemainingBudget {
        attempts: run
            .policy
            .max_attempts
            .saturating_sub(run.attempts.len() as u32 + 1),
        time_ms: run.policy.max_time_ms.saturating_sub(elapsed),
        cost_micros: run
            .policy
            .max_cost_micros
            .map(|max| max.saturating_sub(charged)),
        concurrency: run.policy.max_concurrency,
    };
    let timeout_ms = run
        .policy
        .attempt_time_ms
        .min(run.policy.max_time_ms.saturating_sub(elapsed));
    let pending = request
        .retry_assignment_id
        .map(|id| {
            run.assignments
                .get(id)
                .filter(|assignment| {
                    assignment.visit_id == visit.visit_id && assignment.outcome.is_none()
                })
                .ok_or(ApplicationError::InvalidInput(
                    "assignment is not pending in this phase visit",
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

    let selection = if let Some(routing) = &run.routing {
        let candidates = routing
            .routes
            .get(role)
            .ok_or(ApplicationError::InvalidInput(
                "active profile has no route for the current role",
            ))?;
        let previous = pending.and_then(|assignment| {
            run.attempts
                .values()
                .filter(|attempt| attempt.assignment_id == assignment.assignment_id)
                .max_by_key(|attempt| attempt.ordinal)
        });
        let chosen = if let Some(attempt) = previous {
            let selected = attempt
                .selection
                .as_ref()
                .ok_or(ApplicationError::InvalidInput(
                    "previous attempt has no routed selection",
                ))?;
            if !candidates.contains(selected) {
                return Err(ApplicationError::InvalidInput(
                    "previous selection is outside the run snapshot",
                ));
            }
            selected
        } else {
            candidates.first().ok_or(ApplicationError::InvalidInput(
                "active profile has no model for the current role",
            ))?
        };
        Some(chosen.clone())
    } else {
        None
    };
    let assignment_id = pending.map_or_else(
        || ids.next_id().as_str().to_owned(),
        |assignment| assignment.assignment_id.clone(),
    );
    let attempt_id = ids.next_id().as_str().to_owned();
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
    let input_ids = pending
        .and_then(|a| run.inputs.get(&a.assignment_id))
        .cloned()
        .unwrap_or_else(|| crate::policies::knowledge::inputs(&run));
    if input_ids
        .iter()
        .any(|id| !crate::policies::knowledge::available(&run, &run.artifacts[id], artifacts))
    {
        return Err(ApplicationError::InvalidInput(
            "input artifact is missing or changed after registration",
        ));
    }
    if pending.is_none() {
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::AssignmentInputs {
                assignment_id: assignment_id.clone(),
                artifact_ids: input_ids.clone(),
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
            selection: selection.clone(),
        },
    ));
    events.push(event(
        clock,
        ids,
        &run.run_id,
        EventKind::AttemptCharged {
            attempt_id: attempt_id.clone(),
            cost_micros: run.policy.attempt_cost_micros,
        },
    ));
    store
        .append_boundary(&events)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome {
        artifact_path: crate::policies::knowledge::output_path(phase, &attempt_id),
        input_artifacts: input_ids
            .iter()
            .map(|id| run.artifacts[id].clone())
            .collect(),
        phase: phase.name(),
        artifact_kind,
        timeout_ms,
        budget,
        run_id: run.run_id,
        assignment_id,
        attempt_id,
        role,
        selection,
    })
}
