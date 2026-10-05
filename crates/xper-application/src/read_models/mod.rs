//! Rebuildable observations which never decide or validate execution policy.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

mod replay;
pub use replay::replay;

/// A bounded page of recorded runs, newest recordings before legacy history.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    /// Recorded projections in stable creation order, newest first.
    pub runs: Vec<RunProjection>,
    /// Opaque continuation identity; absent when this is the final page.
    pub next_cursor: Option<String>,
}

/// Generic measurements derived from reported facts, with versioned formulas.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMetrics {
    /// Version of these counting and aggregation definitions.
    pub formula_version: u32,
    /// Number of unique stored events, including unknown adapter event types.
    pub event_count: u64,
    /// Distinct attempt IDs observed in `attempt.started` events.
    pub attempts_started: u64,
    /// Distinct attempt IDs observed in `attempt.finished` events.
    pub attempts_finished: u64,
    /// Counts of last reported finish outcome per attempt ID. Unknown when more
    /// than 64 distinct labels are observed; a partial classification is never returned.
    pub outcomes: Option<BTreeMap<String, u64>>,
    /// Sum within JavaScript safe integers when every report supplies input tokens.
    pub input_tokens: Option<u64>,
    /// Sum within JavaScript safe integers when every report supplies output tokens.
    pub output_tokens: Option<u64>,
    /// Sum within JavaScript safe integers when every report supplies cost.
    pub cost_micros: Option<u64>,
    /// Number of reported model-usage observations.
    pub usage_reports: u64,
}

impl Default for RunMetrics {
    fn default() -> Self {
        Self {
            formula_version: 1,
            event_count: 0,
            attempts_started: 0,
            attempts_finished: 0,
            outcomes: Some(BTreeMap::new()),
            input_tokens: None,
            output_tokens: None,
            cost_micros: None,
            usage_reports: 0,
        }
    }
}

/// The latest labels reported by the adapter, plus generic observed metrics.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjection {
    /// Recording identity supplied by the adapter.
    pub run_id: String,
    /// Session to which the recorder bound this run; absent in unbound legacy history.
    pub session_id: Option<String>,
    /// Last reported status up to 256 UTF-8 bytes, or `unknown` if unavailable.
    pub status: String,
    /// Last reported phase label up to 256 UTF-8 bytes, with no transition policy.
    pub phase: Option<String>,
    /// Earliest producer timestamp in the recording.
    pub started_at: u64,
    /// Latest producer timestamp in the recording.
    pub last_event_at: u64,
    /// Facts counted without deriving missing execution outcomes.
    pub metrics: RunMetrics,
}
