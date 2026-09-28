//! Projection of adapter facts, independent of the workflow which produced them.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::events::{MAX_IDENTITY_BYTES, MAX_SAFE_INTEGER, RecordedEvent};

use super::{RunMetrics, RunProjection};

/// Replays append-ordered observations. Unknown event types and adapter
/// checkpoints are retained by the recorder but have no projection side effects.
/// No event sequence is rejected and no unreported outcome is synthesized.
#[must_use]
pub fn replay(session_id: &str, events: &[RecordedEvent]) -> Option<RunProjection> {
    let first = events.first()?;
    let mut run = RunProjection {
        run_id: first.run_id.clone(),
        session_id: (!session_id.is_empty()).then(|| session_id.into()),
        status: "unknown".into(),
        phase: None,
        started_at: first.occurred_at,
        last_event_at: first.occurred_at,
        metrics: RunMetrics::default(),
    };
    let mut started = BTreeSet::new();
    let mut finished = BTreeMap::new();
    for event in events {
        run.started_at = run.started_at.min(event.occurred_at);
        run.last_event_at = run.last_event_at.max(event.occurred_at);
        run.metrics.event_count += 1;
        match event.event_type.as_str() {
            "run.started" => {
                run.status = if event.data.contains_key("status") {
                    text(&event.data, "status").unwrap_or("unknown")
                } else {
                    "running"
                }
                .into();
            }
            "run.status" | "run.finished" => {
                run.status = text(&event.data, "status")
                    .or_else(|| text(&event.data, "outcome"))
                    .unwrap_or("unknown")
                    .into();
            }
            "phase.entered" => {
                run.phase = text(&event.data, "phase").map(str::to_owned);
            }
            "attempt.started" => {
                if let Some(attempt) = identity(&event.data, "attemptId") {
                    started.insert(attempt);
                }
            }
            "attempt.finished" => {
                if let Some(attempt) = identity(&event.data, "attemptId") {
                    finished.insert(attempt, text(&event.data, "outcome").unwrap_or("unknown"));
                }
            }
            "model.usage" => observe_usage(&mut run.metrics, &event.data),
            _ => {}
        }
    }
    run.metrics.attempts_started = started.len() as u64;
    run.metrics.attempts_finished = finished.len() as u64;
    for outcome in finished.values() {
        let Some(outcomes) = &mut run.metrics.outcomes else {
            break;
        };
        if outcomes.len() == 64 && !outcomes.contains_key(*outcome) {
            run.metrics.outcomes = None;
            break;
        }
        *outcomes.entry((*outcome).into()).or_default() += 1;
    }
    Some(run)
}

// This bound only limits compact projections. Oversized producer labels stay
// unchanged in the timeline and never cause the recording to be rejected.
fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    identity(data, key).filter(|value| value.len() <= MAX_IDENTITY_BYTES)
}

// Correlation IDs inside payloads are not repeated in compact projections, so
// their length does not change whether an observed attempt can be counted.
fn identity<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key)?
        .as_str()
        .filter(|value| !value.trim().is_empty())
}

fn observe_usage(metrics: &mut RunMetrics, data: &Map<String, Value>) {
    let first = metrics.usage_reports == 0;
    aggregate(&mut metrics.input_tokens, data.get("inputTokens"), first);
    aggregate(&mut metrics.output_tokens, data.get("outputTokens"), first);
    aggregate(&mut metrics.cost_micros, data.get("costMicros"), first);
    metrics.usage_reports += 1;
}

fn aggregate(total: &mut Option<u64>, observed: Option<&Value>, first: bool) {
    let value = observed
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER);
    *total = if first {
        value
    } else {
        total
            .and_then(|sum| value.and_then(|value| sum.checked_add(value)))
            .filter(|value| *value <= MAX_SAFE_INTEGER)
    };
}
