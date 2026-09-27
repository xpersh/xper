//! Translate the public RPC contract to typed application requests and results.

use serde_json::{Value, json};
use xper_application::{
    ApplicationError,
    events::WorkOutcome,
    use_cases::{advance_run, finish_attempt, get_run_status, start_discovery, start_run},
};

use super::empty_params;
use crate::composition::WorkflowRuntime;

fn require<'a>(params: &'a Value, field: &str) -> Result<&'a str, ApplicationError> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ApplicationError::InvalidInput(
            "missing or empty workflow parameter",
        ))
}

pub(super) fn handle(
    runtime: &mut WorkflowRuntime,
    method: &str,
    params: &Value,
) -> Result<Value, ApplicationError> {
    let WorkflowRuntime {
        store,
        artifacts,
        clock,
        ids,
        metadata,
        routing,
        session_id,
    } = runtime;
    match method {
        "run.start" => {
            let available_models = params
                .get("models")
                .map(|value| {
                    value
                        .as_array()
                        .ok_or(ApplicationError::InvalidInput("models must be a list"))?
                        .iter()
                        .map(|model| {
                            Ok(start_run::AvailableModel {
                                provider: model
                                    .get("provider")
                                    .and_then(Value::as_str)
                                    .filter(|text| !text.is_empty())
                                    .ok_or(ApplicationError::InvalidInput(
                                        "invalid model provider",
                                    ))?
                                    .into(),
                                model: model
                                    .get("model")
                                    .and_then(Value::as_str)
                                    .filter(|text| !text.is_empty())
                                    .ok_or(ApplicationError::InvalidInput("invalid model ID"))?
                                    .into(),
                                reasoning: model.get("reasoning").and_then(Value::as_bool).ok_or(
                                    ApplicationError::InvalidInput(
                                        "invalid model reasoning capability",
                                    ),
                                )?,
                            })
                        })
                        .collect::<Result<Vec<_>, ApplicationError>>()
                })
                .transpose()?;
            let result = start_run::execute(
                store,
                clock,
                ids,
                start_run::Request {
                    session_id,
                    metadata,
                    routing: routing.as_ref(),
                    available_models: available_models.as_deref(),
                    objective: params
                        .get("objective")
                        .and_then(Value::as_str)
                        .ok_or(ApplicationError::InvalidInput("objective required"))?,
                },
            )?;
            Ok(json!({"runId":result.run_id,"phase":result.phase,"resumed":result.resumed}))
        }
        "assignment.start" => {
            let retry_assignment_id = if empty_params(params) {
                None
            } else if params.as_object().is_some_and(|map| map.len() == 1) {
                Some(
                    params
                        .get("assignmentId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .ok_or(ApplicationError::InvalidInput("assignmentId required"))?,
                )
            } else {
                return Err(ApplicationError::InvalidInput("invalid params"));
            };
            let result = start_discovery::execute(
                store,
                clock,
                ids,
                start_discovery::Request {
                    session_id,
                    retry_assignment_id,
                },
            )?;
            Ok(
                json!({"runId":result.run_id,"assignmentId":result.assignment_id,"attemptId":result.attempt_id,"role":result.role,"selection":result.selection}),
            )
        }
        "attempt.finish" => {
            let outcome = match require(params, "outcome")? {
                "succeeded" => WorkOutcome::Succeeded,
                "failed" => WorkOutcome::Failed,
                "cancelled" => WorkOutcome::Cancelled,
                "timed_out" => WorkOutcome::TimedOut,
                _ => return Err(ApplicationError::InvalidInput("unknown attempt outcome")),
            };
            let result = finish_attempt::execute(
                store,
                artifacts,
                clock,
                ids,
                finish_attempt::Request {
                    session_id,
                    attempt_id: require(params, "attemptId")?,
                    outcome,
                    artifact_path: params.get("artifactPath").and_then(Value::as_str),
                },
            )?;
            if result.replayed {
                Ok(json!({"attemptId":result.attempt_id,"outcome":result.outcome,"replayed":true}))
            } else {
                Ok(
                    json!({"attemptId":result.attempt_id,"outcome":result.outcome,"artifactId":result.artifact_id}),
                )
            }
        }
        "run.advance" if empty_params(params) => {
            match advance_run::execute(
                store,
                artifacts,
                clock,
                ids,
                advance_run::Request { session_id },
            )? {
                advance_run::Outcome::Blocked { reason } => {
                    Ok(json!({"advanced":false,"phase":"discovery","reason":reason}))
                }
                advance_run::Outcome::Advanced { resumed: true } => {
                    Ok(json!({"advanced":true,"phase":"define","resumed":true}))
                }
                advance_run::Outcome::Advanced { resumed: false } => {
                    Ok(json!({"advanced":true,"phase":"define"}))
                }
            }
        }
        "run.status" if empty_params(params) => {
            let result =
                get_run_status::execute(store, get_run_status::Query::Session(session_id))?;
            let mut value = json!({"run":result.run,"timeline":result.timeline,"durability":format!("{:?}",store.durability()).to_lowercase()});
            if result.run.is_some() {
                value["degradedReason"] = json!(store.degraded_reason());
            }
            Ok(value)
        }
        "profile.inspect" if empty_params(params) => Ok(json!({"routing":routing})),
        _ => Err(ApplicationError::InvalidInput("invalid params")),
    }
}
