//! Evaluate Discovery evidence and enter Define when its gate passes.

use crate::{
    ApplicationError,
    events::{EventKind, GateOutcome},
    policies::discovery::discovery_ready,
    ports::{ArtifactReader, Clock, IdGenerator, RunRepository},
};

use super::support::{active, event};

/// Intent to advance the run belonging to one session.
pub struct Request<'a> {
    /// Session whose current phase is evaluated.
    pub session_id: &'a str,
}

/// Gate decision, including a durable rejection without a phase transition.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Discovery's gate did not pass.
    Blocked {
        /// Explanation suitable for presentation by an interface.
        reason: &'static str,
    },
    /// The run is in Define.
    Advanced {
        /// Whether Define was already active before this call.
        resumed: bool,
    },
}

/// Persists the gate evaluation and, when passed, the full phase boundary.
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
    if visit.phase == "define" {
        return Ok(Outcome::Advanced { resumed: true });
    }
    if visit.phase != "discovery" {
        return Err(ApplicationError::InvalidInput("Discovery is not active"));
    }
    // Unreadable evidence cannot satisfy the gate, just like missing evidence.
    let valid = discovery_ready(&run, |path| artifacts.is_available(path).unwrap_or(false));
    let gate_id = ids.next_id().as_str().to_owned();
    let evaluation = event(
        clock,
        ids,
        &run.run_id,
        EventKind::GateEvaluated {
            gate_id: gate_id.clone(),
            visit_id: visit.visit_id.clone(),
            outcome: if valid {
                GateOutcome::Passed
            } else {
                GateOutcome::Failed
            },
        },
    );
    if !valid {
        store
            .append_boundary(&[evaluation])
            .map_err(ApplicationError::dependency)?;
        let reason =
            if run.assignments.values().any(|assignment| {
                assignment.visit_id == visit.visit_id && assignment.outcome.is_none()
            }) {
                "Discovery assignments are still running"
            } else {
                "Discovery Brief from a successful explorer assignment is required"
            };
        return Ok(Outcome::Blocked { reason });
    }
    let target_visit = ids.next_id().as_str().to_owned();
    let events = [
        evaluation,
        event(
            clock,
            ids,
            &run.run_id,
            EventKind::GatePassed {
                gate_id: gate_id.clone(),
                visit_id: visit.visit_id.clone(),
            },
        ),
        event(
            clock,
            ids,
            &run.run_id,
            EventKind::PhaseExited {
                visit_id: visit.visit_id.clone(),
                phase: "discovery".into(),
                gate_id,
            },
        ),
        event(
            clock,
            ids,
            &run.run_id,
            EventKind::PhaseEntered {
                visit_id: target_visit,
                phase: "define".into(),
                visit_number: 1,
            },
        ),
    ];
    store
        .append_boundary(&events)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome::Advanced { resumed: false })
}
