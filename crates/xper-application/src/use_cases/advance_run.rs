//! Evaluate knowledge evidence, request human input, or revisit its origin.
use super::support::{active, event};
use crate::{
    ApplicationError,
    events::{EventKind, GateOutcome},
    knowledge::KnowledgeOutput,
    policies::knowledge,
    ports::{ArtifactReader, Clock, IdGenerator, RunRepository},
};
use serde::Serialize;
use xper_domain::{Phase, is_allowed_transition};

/// Intent to evaluate the current gate. Approval is explicit and artifact-bound.
pub struct Request<'a> {
    /// Owning session.
    pub session_id: &'a str,
    /// Artifact from a pending human request, supplied only on explicit approval.
    pub approved_artifact_id: Option<&'a str>,
}

/// Gate result; a ready Plan remains in Plan without executing implementation.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Whether the gate passed or authorized a revisit.
    pub advanced: bool,
    /// Current phase after evaluating the gate.
    pub phase: String,
    /// Stable explanation of a block or revisit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// A validated execution plan is available.
    pub ready: bool,
    /// Repeated evaluation of an already accepted Plan.
    pub resumed: bool,
    /// Artifact needing explicit human approval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_artifact_id: Option<String>,
}

/// Persist gate evaluation and the entire transition atomically.
pub fn execute(
    store: &mut impl RunRepository,
    artifacts: &impl ArtifactReader,
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    request: Request<'_>,
) -> Result<Outcome, ApplicationError> {
    let run = active(store, request.session_id)?;
    let phase = knowledge::phase(&run)?;
    let visit = run.visits.last().expect("knowledge visit");
    let mut result = Outcome {
        advanced: false,
        phase: phase.name().into(),
        reason: None,
        ready: false,
        resumed: false,
        human_artifact_id: None,
    };
    let elapsed = clock
        .now()
        .as_millis()
        .saturating_sub(run.visits[0].entered_at_ms);
    let mut reason = (elapsed >= run.policy.max_time_ms).then_some("run time budget exhausted");
    let mut target = phase.next_knowledge();
    let mut feedback = false;
    if run
        .assignments
        .values()
        .any(|a| a.visit_id == visit.visit_id && a.outcome.is_none())
    {
        reason = Some("phase assignments are still running");
    }
    let history = store
        .load_events(&run.run_id)
        .map_err(ApplicationError::dependency)?;
    let artifact = knowledge::current_artifact(&run, &history);
    if reason.is_none() {
        reason = match artifact {
            None => Some("a successful phase assignment and its output artifact are required"),
            Some(artifact) if !knowledge::available(&run, artifact, artifacts) => {
                Some("phase artifact is missing or changed after registration")
            }
            _ => None,
        };
    }
    if reason.is_none()
        && knowledge::inputs(&run)
            .iter()
            .any(|id| !knowledge::available(&run, &run.artifacts[id], artifacts))
    {
        reason = Some("input artifact is missing or changed after registration");
    }
    if reason.is_none() && phase != Phase::Discovery {
        match knowledge::document(&run, artifact.expect("evidence"), artifacts) {
            Err(error) => reason = Some(error),
            Ok(document) => {
                if let Err(error) = document.output.validate().and_then(|()| {
                    knowledge::validate_links(&document.output, &run, artifacts, elapsed)
                }) {
                    reason = Some(error);
                } else {
                    match document.output {
                        KnowledgeOutput::Feedback { reason: origin, .. } => {
                            let destination = origin.target();
                            if destination == phase {
                                reason =
                                    Some("resolve the reported uncertainty in the current phase");
                            } else if !is_allowed_transition(phase, destination) {
                                reason = Some("feedback must identify an earlier knowledge phase");
                            } else {
                                target = Some(destination);
                                feedback = true;
                            }
                        }
                        KnowledgeOutput::DesignDecisions {
                            feasible: false, ..
                        } => reason = Some("design is infeasible; revise Design before proceeding"),
                        _ => {}
                    }
                }
            }
        }
    }
    if phase == Phase::Plan && run.accepted.contains_key("plan") && reason.is_none() {
        result.advanced = true;
        result.ready = true;
        result.resumed = true;
        return Ok(result);
    }
    let artifact_id = artifact.map(|a| a.artifact_id.clone());
    let needs_human =
        reason.is_none() && !feedback && run.policy.human_gates.iter().any(|p| p == phase.name());
    let approved = needs_human
        && request.approved_artifact_id.is_some_and(|id| {
            artifact_id.as_deref() == Some(id)
                && run.human_input.as_ref() == Some(&(visit.visit_id.clone(), id.to_owned()))
        });
    if request.approved_artifact_id.is_some() && !approved {
        return Err(ApplicationError::InvalidInput(
            "approval does not match a pending current artifact",
        ));
    }
    let gate_id = ids.next_id().as_str().to_owned();
    let mut events = vec![];
    if approved {
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::HumanApproved {
                visit_id: visit.visit_id.clone(),
                artifact_id: artifact_id.clone().expect("evidence"),
            },
        ));
    }
    let waiting = needs_human && !approved;
    events.push(event(
        clock,
        ids,
        &run.run_id,
        EventKind::GateEvaluated {
            gate_id: gate_id.clone(),
            visit_id: visit.visit_id.clone(),
            outcome: if reason.is_some() {
                GateOutcome::Failed
            } else if waiting {
                GateOutcome::HumanDecisionRequired
            } else {
                GateOutcome::Passed
            },
        },
    ));
    if let Some(reason) = reason {
        result.reason = Some(reason.into());
    } else if waiting {
        result.reason = Some("explicit human approval is required for this artifact".into());
        result.human_artifact_id = artifact_id.clone();
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::HumanInputRequested {
                visit_id: visit.visit_id.clone(),
                artifact_id: artifact_id.expect("evidence"),
            },
        ));
    } else {
        result.advanced = true;
        events.push(event(
            clock,
            ids,
            &run.run_id,
            EventKind::GatePassed {
                gate_id: gate_id.clone(),
                visit_id: visit.visit_id.clone(),
            },
        ));
        if feedback {
            events.push(event(
                clock,
                ids,
                &run.run_id,
                EventKind::FeedbackRecorded {
                    artifact_id: artifact_id.expect("evidence"),
                },
            ));
            result.reason =
                Some("revisited the phase responsible for the reported uncertainty".into());
        } else {
            events.push(event(
                clock,
                ids,
                &run.run_id,
                EventKind::PhaseAccepted {
                    visit_id: visit.visit_id.clone(),
                    artifact_id: artifact_id.expect("evidence"),
                },
            ));
        }
        if let Some(target) = target {
            if !is_allowed_transition(phase, target) {
                return Err(ApplicationError::InvalidInput(
                    "unsupported knowledge transition",
                ));
            }
            let number = run
                .visits
                .iter()
                .filter(|v| v.phase == target.name())
                .count() as u32
                + 1;
            let target_id = ids.next_id().as_str().to_owned();
            events.push(event(
                clock,
                ids,
                &run.run_id,
                EventKind::PhaseExited {
                    visit_id: visit.visit_id.clone(),
                    phase: phase.name().into(),
                    gate_id,
                },
            ));
            events.push(event(
                clock,
                ids,
                &run.run_id,
                if number == 1 {
                    EventKind::PhaseEntered {
                        visit_id: target_id,
                        phase: target.name().into(),
                        visit_number: number,
                    }
                } else {
                    EventKind::PhaseRevisited {
                        visit_id: target_id,
                        phase: target.name().into(),
                        visit_number: number,
                    }
                },
            ));
            result.phase = target.name().into();
        } else {
            result.ready = true;
        }
    }
    store
        .append_boundary(&events)
        .map_err(ApplicationError::dependency)?;
    Ok(result)
}
