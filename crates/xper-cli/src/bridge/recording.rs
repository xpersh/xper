//! Translate configuration and recording RPCs without workflow decisions.

use serde_json::{Value, json};
use xper_application::{
    ApplicationError,
    events::RecordedEvent,
    use_cases::{append_events, get_run_status},
};

use super::empty_params;
use crate::{composition::RecordingRuntime, infrastructure::profile_config};

fn invalid(message: &'static str) -> ApplicationError {
    ApplicationError::InvalidInput(message)
}

fn models(value: &Value) -> Result<Vec<profile_config::AvailableModel>, ApplicationError> {
    value
        .as_array()
        .ok_or(invalid("models must be a list"))?
        .iter()
        .map(|model| {
            let name = |key| {
                model
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .ok_or(invalid("model provider and ID must be nonempty strings"))
            };
            if !model.as_object().is_some_and(|map| {
                map.keys()
                    .all(|key| matches!(key.as_str(), "provider" | "model" | "reasoning"))
            }) {
                return Err(invalid("invalid model fields"));
            }
            Ok(profile_config::AvailableModel {
                provider: name("provider")?.into(),
                model: name("model")?.into(),
                reasoning: model
                    .get("reasoning")
                    .and_then(Value::as_bool)
                    .ok_or(invalid("model reasoning capability must be boolean"))?,
            })
        })
        .collect()
}

pub(super) fn handle(
    runtime: &mut RecordingRuntime,
    method: &str,
    params: &Value,
    response_id: &str,
) -> Result<Value, ApplicationError> {
    let RecordingRuntime {
        store,
        root,
        session_id,
    } = runtime;
    match method {
        "event.append" => {
            if !params
                .as_object()
                .is_some_and(|map| map.len() == 1 && map.contains_key("events"))
            {
                return Err(invalid("event.append requires an events array"));
            }
            let events: Vec<RecordedEvent> = serde_json::from_value(params["events"].clone())
                .map_err(|_| invalid("invalid recording event envelope"))?;
            if events.iter().any(|event| {
                serde_json::to_vec(event).map_or(true, |bytes| bytes.len() > 40 * 1024)
            }) {
                return Err(invalid("a recording event cannot exceed 40 KiB"));
            }
            let result = append_events::execute(
                store,
                append_events::Request {
                    session_id,
                    events: &events,
                },
            )?;
            Ok(json!({"accepted":result.accepted,"durability":store.durability().as_str()}))
        }
        "run.status" => {
            if !params.as_object().is_some_and(|map| {
                map.keys()
                    .all(|key| matches!(key.as_str(), "runId" | "after" | "limit"))
            }) {
                return Err(invalid("invalid status parameters"));
            }
            let name = |key| {
                params
                    .get(key)
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|text| !text.trim().is_empty())
                            .ok_or(invalid("runId and after must be nonempty strings"))
                    })
                    .transpose()
            };
            let query = name("runId")?.map_or(
                get_run_status::Query::Session(session_id),
                get_run_status::Query::Run,
            );
            let limit = params
                .get("limit")
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|n| (1..=1000).contains(n))
                        .ok_or(invalid("limit must be between 1 and 1000"))
                })
                .transpose()?
                .unwrap_or(100) as usize;
            let result = get_run_status::execute(store, query)?;
            let offset = match name("after")? {
                None => 0,
                Some(after) => {
                    result
                        .timeline
                        .iter()
                        .position(|event| event.event_id == after)
                        .ok_or(invalid("unknown timeline cursor"))?
                        + 1
                }
            };
            let mut response = json!({"run":result.run,"timeline":[],"durability":store.durability().as_str(),"degradedReason":store.degraded_reason(),"nextCursor":null});
            let mut page = Vec::new();
            for event in result.timeline.iter().skip(offset).take(limit) {
                page.push(event);
                let mut candidate = response.clone();
                candidate["timeline"] = json!(page);
                candidate["nextCursor"] = if offset + page.len() < result.timeline.len() {
                    json!(event.event_id)
                } else {
                    Value::Null
                };
                let frame = xper_protocol::Message::Response {
                    id: response_id.into(),
                    result: candidate.clone(),
                }
                .to_frame();
                if frame.len() > xper_protocol::MAX_FRAME_BYTES + 1 {
                    page.pop();
                    break;
                }
                response = candidate;
            }
            if page.is_empty() && offset < result.timeline.len() {
                return Err(invalid(
                    "recorded history exceeds the page limit; inspect it with the CLI",
                ));
            }
            Ok(response)
        }
        "profile.inspect" if empty_params(params) => {
            let routing = profile_config::resolved_active(root)
                .map_err(|error| ApplicationError::Dependency(Box::new(error)))?;
            Ok(json!({"routing":routing}))
        }
        "configuration.resolve" => {
            if !params
                .as_object()
                .is_some_and(|map| map.keys().all(|key| key == "models"))
            {
                return Err(invalid("invalid configuration parameters"));
            }
            let catalog = params.get("models").map(models).transpose()?;
            let (routing, config) = profile_config::configuration(root)
                .map_err(|error| ApplicationError::Dependency(Box::new(error)))?;
            if let Some(route) = &routing {
                let catalog = catalog
                    .as_deref()
                    .ok_or(invalid("active profile requires the adapter model catalog"))?;
                profile_config::validate_catalog(route, catalog)
                    .map_err(|_| invalid("configured model is unavailable or lacks the requested reasoning capability"))?;
            }
            Ok(json!({"routing":routing,"adapterConfig":config}))
        }
        _ => Err(invalid("invalid parameters")),
    }
}
