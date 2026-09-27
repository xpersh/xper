//! Start a session's run in Discovery, or resume its active run.

use xper_domain::{GateEvaluation, GateResult, Phase, Run, TransitionRequest};

use crate::{
    ApplicationError,
    events::{AdapterMetadata, Event, RoutingSnapshot},
    ports::{Clock, IdGenerator, RunRepository},
    read_models::RunStatus,
};

use super::support::current;

/// Intent to start work in one attached session.
pub struct Request<'a> {
    /// Harness-neutral session key.
    pub session_id: &'a str,
    /// Objective used by the domain but excluded from durable events.
    pub objective: &'a str,
    /// Adapter capabilities captured for a new run.
    pub metadata: &'a AdapterMetadata,
    /// Resolved routing frozen for a new run, if a profile is active.
    pub routing: Option<&'a RoutingSnapshot>,
    /// Harness-reported model catalog for the selected context.
    pub available_models: Option<&'a [AvailableModel]>,
}

/// Model availability and reasoning capability reported by an adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvailableModel {
    /// Exact provider identifier.
    pub provider: String,
    /// Exact model identifier.
    pub model: String,
    /// Whether the model supports non-off thinking levels.
    pub reasoning: bool,
}

/// Identity and phase of the started or resumed run.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Persisted run identity.
    pub run_id: String,
    /// Current phase, if the run has entered one.
    pub phase: Option<String>,
    /// Whether this request found an already active run.
    pub resumed: bool,
}

/// Commits Intake → Discovery and the session binding as a single boundary.
pub fn execute(
    store: &mut impl RunRepository,
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    if request.objective.trim().is_empty() {
        return Err(ApplicationError::InvalidInput("objective required"));
    }
    if request.session_id.trim().is_empty() {
        return Err(ApplicationError::InvalidInput("session ID required"));
    }
    if let Some(run) = current(store, request.session_id)?
        && run.status == RunStatus::Active
    {
        return Ok(Outcome {
            phase: run.visits.last().map(|visit| visit.phase.clone()),
            run_id: run.run_id,
            resumed: true,
        });
    }
    if let Some(routing) = request.routing {
        let available = request
            .available_models
            .ok_or(ApplicationError::InvalidInput(
                "adapter model catalog required for the active profile",
            ))?;
        for selections in routing.routes.values() {
            for selected in selections {
                let model = available
                    .iter()
                    .find(|candidate| {
                        candidate.provider == selected.provider && candidate.model == selected.model
                    })
                    .ok_or(ApplicationError::InvalidInput(
                        "profile model is unavailable in the active context",
                    ))?;
                if selected.thinking != "off" && !model.reasoning {
                    return Err(ApplicationError::InvalidInput(
                        "profile thinking level is unsupported by the model",
                    ));
                }
            }
        }
    }
    let (mut run, mut domain_events) = Run::start(request.objective, clock, ids).into_parts();
    let transition = run
        .transition(
            TransitionRequest::new(
                ids.next_id().into(),
                Phase::Discovery,
                GateEvaluation::new("intake.ready", GateResult::Passed, vec![]),
            ),
            clock,
            ids,
        )
        .map_err(ApplicationError::dependency)?;
    domain_events.extend_from_slice(transition.events());
    let events: Vec<_> = domain_events
        .iter()
        .map(|event| Event::from_domain(event, request.metadata, request.routing))
        .collect();
    let run_id = run.id().as_str().to_owned();
    store
        .append_boundary_and_bind_session(&events, request.session_id, &run_id)
        .map_err(ApplicationError::dependency)?;
    Ok(Outcome {
        run_id,
        phase: Some("discovery".into()),
        resumed: false,
    })
}
