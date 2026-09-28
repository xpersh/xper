//! Passive recording contract and projection tests using an explicit port double.

use std::{collections::BTreeMap, io};

use serde_json::{Value, json};
use xper_application::{
    ApplicationError,
    events::RecordedEvent,
    ports::{RunReader, RunRepository},
    read_models::{RunProjection, replay},
    use_cases::{append_events, get_run_status},
};

fn event(id: &str, kind: &str, data: Value) -> RecordedEvent {
    RecordedEvent {
        schema_version: 1,
        event_id: id.into(),
        run_id: "run".into(),
        occurred_at: 100,
        event_type: kind.into(),
        data: data.as_object().unwrap().clone(),
    }
}

#[derive(Default)]
struct Recorder {
    appends: usize,
    events: Vec<RecordedEvent>,
    owner: String,
    reject: bool,
}

impl RunReader for Recorder {
    type Error = io::Error;

    fn load_run(&self, run_id: &str) -> Result<Option<RunProjection>, Self::Error> {
        Ok(replay(&self.owner, &self.events).filter(|run| run.run_id == run_id))
    }

    fn load_events(&self, _: &str) -> Result<Vec<RecordedEvent>, Self::Error> {
        Ok(self.events.clone())
    }

    fn latest_run(&self) -> Result<Option<RunProjection>, Self::Error> {
        Ok(replay(&self.owner, &self.events))
    }

    fn session_run(&self, session_id: &str) -> Result<Option<String>, Self::Error> {
        Ok((session_id == self.owner).then(|| "run".into()))
    }
}

impl RunRepository for Recorder {
    fn invalid_input_message(error: &Self::Error) -> Option<&'static str> {
        (error.kind() == io::ErrorKind::InvalidInput).then_some("foreign session")
    }

    fn append_events(&mut self, session_id: &str, events: &[RecordedEvent]) -> io::Result<usize> {
        self.appends += 1;
        if self.reject {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "foreign session",
            ));
        }
        self.owner = session_id.into();
        self.events.extend_from_slice(events);
        Ok(events.len())
    }
}

#[test]
fn arbitrary_workflow_facts_and_checkpoints_pass_through_unchanged() {
    let events = vec![
        event(
            "1",
            "phase.entered",
            json!({"phase":"unexpected future stage"}),
        ),
        event("2", "phase.entered", json!({"phase":"begin again"})),
        event(
            "3",
            "adapter.state",
            json!({"state":{"phase":"private","budget":-1}}),
        ),
        event(
            "4",
            "custom.agent.reflection",
            json!({"labels":["free",17]}),
        ),
    ];
    let mut recorder = Recorder::default();
    let outcome = append_events::execute(
        &mut recorder,
        append_events::Request {
            session_id: "session",
            events: &events,
        },
    )
    .unwrap();
    assert_eq!(outcome.accepted, 4);
    assert_eq!(recorder.appends, 1);
    assert_eq!(recorder.events, events);
    let status =
        get_run_status::execute(&recorder, get_run_status::Query::Session("session")).unwrap();
    let run = status.run.unwrap();
    assert_eq!(run.phase.as_deref(), Some("begin again"));
    assert_eq!(run.status, "unknown");
    assert_eq!(status.timeline, events);
}

#[test]
fn invalid_envelopes_or_mixed_run_batches_never_reach_the_write_port() {
    let good = event("event", "anything", json!({}));
    let mut bad_events = Vec::new();
    let mut bad = good.clone();
    bad.schema_version = 2;
    bad_events.push(bad);
    let mut bad = good.clone();
    bad.event_id = " ".into();
    bad_events.push(bad);
    let mut bad = good.clone();
    bad.run_id = "".into();
    bad_events.push(bad);
    let mut bad = good.clone();
    bad.event_type = "\t".into();
    bad_events.push(bad);
    let mut bad = good.clone();
    bad.occurred_at = 9_007_199_254_740_992;
    bad_events.push(bad);
    let mut recorder = Recorder::default();
    for bad in bad_events {
        assert!(matches!(
            append_events::execute(
                &mut recorder,
                append_events::Request {
                    session_id: "session",
                    events: &[bad],
                }
            ),
            Err(ApplicationError::InvalidInput(_))
        ));
    }
    for (session_id, events) in [("session", vec![]), (" ", vec![good.clone()])] {
        assert!(
            append_events::execute(
                &mut recorder,
                append_events::Request {
                    session_id,
                    events: &events
                }
            )
            .is_err()
        );
    }
    let mut other = good.clone();
    other.run_id = "other".into();
    assert!(
        append_events::execute(
            &mut recorder,
            append_events::Request {
                session_id: "session",
                events: &[good, other]
            }
        )
        .is_err()
    );
    assert_eq!(recorder.appends, 0);
}

#[test]
fn ownership_rejections_remain_invalid_requests() {
    let mut recorder = Recorder {
        reject: true,
        ..Recorder::default()
    };
    let result = append_events::execute(
        &mut recorder,
        append_events::Request {
            session_id: "foreign",
            events: &[event("e", "run.started", json!({}))],
        },
    );
    assert!(matches!(
        result,
        Err(ApplicationError::InvalidInput("foreign session"))
    ));
}

#[test]
fn unbound_sessions_and_unknown_runs_do_not_leak_the_latest_recording() {
    let recorder = Recorder {
        owner: "owner".into(),
        events: vec![event("e", "run.started", json!({}))],
        ..Recorder::default()
    };
    for query in [
        get_run_status::Query::Session("foreign"),
        get_run_status::Query::Run("unknown"),
    ] {
        let result = get_run_status::execute(&recorder, query).unwrap();
        assert!(result.run.is_none());
        assert!(result.timeline.is_empty());
    }
}

#[test]
fn replay_counts_reported_outcomes_without_requiring_starts_or_synthesizing_finishes() {
    let events = [
        event(
            "1",
            "attempt.finished",
            json!({"attemptId":"late-start","outcome":"custom verdict"}),
        ),
        event("2", "attempt.started", json!({"attemptId":"late-start"})),
        event("3", "attempt.started", json!({"attemptId":"still-open"})),
        event("4", "attempt.started", json!({"attemptId":"still-open"})),
        event("5", "run.finished", json!({"status":"waiting for owner"})),
        event("6", "run.started", json!({})),
    ];
    let run = replay("session", &events).unwrap();
    assert_eq!(run.status, "running");
    assert_eq!(run.metrics.attempts_started, 2);
    assert_eq!(run.metrics.attempts_finished, 1);
    assert_eq!(
        run.metrics.outcomes,
        Some(BTreeMap::from([("custom verdict".into(), 1)]))
    );
    assert_eq!(run.metrics.input_tokens, None);
    assert_eq!(run.metrics.cost_micros, None);
}

#[test]
fn usage_totals_require_complete_reports_and_preserve_reported_zero() {
    let events = [
        event(
            "1",
            "model.usage",
            json!({"inputTokens":10,"outputTokens":0,"costMicros":0}),
        ),
        event(
            "2",
            "model.usage",
            json!({"inputTokens":20,"outputTokens":3,"costMicros":0}),
        ),
    ];
    let metrics = replay("session", &events).unwrap().metrics;
    assert_eq!(metrics.formula_version, 1);
    assert_eq!(metrics.input_tokens, Some(30));
    assert_eq!(metrics.output_tokens, Some(3));
    assert_eq!(metrics.cost_micros, Some(0));
    let partial = [
        events[0].clone(),
        event("3", "model.usage", json!({"inputTokens":1})),
    ];
    let metrics = replay("session", &partial).unwrap().metrics;
    assert_eq!(metrics.input_tokens, Some(11));
    assert_eq!(metrics.output_tokens, None);
    assert_eq!(metrics.cost_micros, None);
    assert_eq!(metrics.usage_reports, 2);
}

#[test]
fn missing_usage_remains_unknown_even_if_later_reports_supply_it() {
    let events = [
        event(
            "1",
            "model.usage",
            json!({"inputTokens":u64::MAX,"costMicros":-1}),
        ),
        event(
            "2",
            "model.usage",
            json!({"inputTokens":1,"outputTokens":4,"costMicros":12}),
        ),
    ];
    let metrics = replay("session", &events).unwrap().metrics;
    assert_eq!(metrics.input_tokens, None);
    assert_eq!(metrics.output_tokens, None);
    assert_eq!(metrics.cost_micros, None);
}

#[test]
fn envelope_round_trips_camel_case_and_rejects_non_object_payloads() {
    let original = event("e", "vendor.event", json!({"opaque":{"nested":true}}));
    let serialized = serde_json::to_value(&original).unwrap();
    assert_eq!(serialized["schemaVersion"], 1);
    assert_eq!(serialized["type"], "vendor.event");
    assert_eq!(
        serde_json::from_value::<RecordedEvent>(serialized.clone()).unwrap(),
        original
    );
    for bad in [Value::Null, json!([]), json!("text")] {
        let mut mutated = serialized.clone();
        mutated["data"] = bad;
        assert!(serde_json::from_value::<RecordedEvent>(mutated).is_err());
    }
}

#[test]
fn envelope_limits_count_utf8_bytes_and_leave_payloads_extensible() {
    let mut valid = event(
        &"é".repeat(128),
        &"t".repeat(256),
        json!({"payload":"x".repeat(30_000)}),
    );
    valid.run_id = "r".repeat(256);
    assert!(append_events::validate_batch(&"s".repeat(256), std::slice::from_ref(&valid)).is_ok());
    for field in ["eventId", "runId", "type"] {
        let mut too_long = valid.clone();
        match field {
            "eventId" => too_long.event_id = "é".repeat(129),
            "runId" => too_long.run_id = "r".repeat(257),
            _ => too_long.event_type = "t".repeat(257),
        }
        assert!(append_events::validate_batch("session", &[too_long]).is_err());
    }
    assert!(append_events::validate_batch(&"é".repeat(129), &[valid]).is_err());
}

#[test]
fn oversized_projection_labels_become_unknown_without_changing_original_facts() {
    let large = "p".repeat(30_000);
    let events = [
        event("1", "phase.entered", json!({"phase":"old phase"})),
        event("2", "phase.entered", json!({"phase":large})),
        event("3", "run.status", json!({"status":large})),
        event(
            "4",
            "attempt.finished",
            json!({"attemptId":"correlation".repeat(1000),"outcome":large}),
        ),
    ];
    let run = replay("session", &events).unwrap();
    assert_eq!(run.phase, None);
    assert_eq!(run.status, "unknown");
    assert_eq!(
        run.metrics.outcomes,
        Some(BTreeMap::from([("unknown".into(), 1)]))
    );
    assert_eq!(events[1].data["phase"], large);
    assert_eq!(events[2].data["status"], large);
    assert_eq!(events[3].data["outcome"], large);
    let explicit_start = [event("5", "run.started", json!({"status":"é".repeat(129)}))];
    assert_eq!(
        replay("session", &explicit_start).unwrap().status,
        "unknown"
    );
}

#[test]
fn excess_outcome_cardinality_returns_unknown_instead_of_partial_counts() {
    let mut events = Vec::new();
    for i in 0..64 {
        events.push(event(
            &format!("event-{i}"),
            "attempt.finished",
            json!({"attemptId":format!("attempt-{i}"),"outcome":format!("outcome-{i}")}),
        ));
    }
    assert_eq!(
        replay("session", &events)
            .unwrap()
            .metrics
            .outcomes
            .unwrap()
            .len(),
        64
    );
    events.push(event(
        "event-65",
        "attempt.finished",
        json!({"attemptId":"attempt-65","outcome":"outcome-65"}),
    ));
    let metrics = replay("session", &events).unwrap().metrics;
    assert_eq!(metrics.outcomes, None);
    assert_eq!(metrics.attempts_finished, 65);
}

#[test]
fn usage_totals_become_unknown_outside_javascript_safe_integer_range() {
    let maximum = xper_application::events::MAX_SAFE_INTEGER;
    let first = event(
        "1",
        "model.usage",
        json!({"inputTokens":maximum,"outputTokens":maximum,"costMicros":maximum}),
    );
    assert_eq!(
        replay("session", std::slice::from_ref(&first))
            .unwrap()
            .metrics
            .cost_micros,
        Some(maximum)
    );
    let next = event(
        "2",
        "model.usage",
        json!({"inputTokens":1,"outputTokens":0,"costMicros":1}),
    );
    let metrics = replay("session", &[first, next]).unwrap().metrics;
    assert_eq!(metrics.input_tokens, None);
    assert_eq!(metrics.output_tokens, Some(maximum));
    assert_eq!(metrics.cost_micros, None);
    let invalid = event(
        "3",
        "model.usage",
        json!({"inputTokens":maximum+1,"outputTokens":maximum+1,"costMicros":maximum+1}),
    );
    let metrics = replay("session", &[invalid]).unwrap().metrics;
    assert_eq!(metrics.input_tokens, None);
    assert_eq!(metrics.output_tokens, None);
    assert_eq!(metrics.cost_micros, None);
}
