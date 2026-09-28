//! Versioned recording envelopes and harness-neutral model configuration.
//!
//! Event names and payloads belong to their producers. The recorder validates
//! identity and envelope integrity, without authorizing workflow decisions.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use xper_domain::Identifier;

/// Supported recording envelope version, independent of adapter payload versions.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

/// Mechanical UTF-8 byte limit for envelope names and session identifiers.
/// Bounded identities keep acknowledgements and pagination cursors frameable.
pub const MAX_IDENTITY_BYTES: usize = 256;

/// Largest exactly representable integer shared by Rust and JavaScript clients.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// One fact reported by an adapter, retained without rewriting its payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedEvent {
    /// Recording envelope version.
    pub schema_version: u32,
    /// Globally unique idempotency key allocated by the producer.
    pub event_id: String,
    /// Run to which this observation belongs.
    pub run_id: String,
    /// Producer-reported Unix time in milliseconds; append order remains authoritative.
    pub occurred_at: u64,
    /// Extensible event name, interpreted only by interested projections.
    #[serde(rename = "type")]
    pub event_type: String,
    /// Adapter-defined facts or an opaque adapter checkpoint.
    pub data: Map<String, Value>,
}

impl RecordedEvent {
    /// Checks envelope integrity without inspecting workflow payloads.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != EVENT_SCHEMA_VERSION {
            return Err("unsupported recording event schema version");
        }
        if Identifier::new(&self.event_id).is_err() {
            return Err("event ID must not be empty");
        }
        if Identifier::new(&self.run_id).is_err() {
            return Err("run ID must not be empty");
        }
        if self.event_type.trim().is_empty() {
            return Err("event type must not be empty");
        }
        if [&self.event_id, &self.run_id, &self.event_type]
            .iter()
            .any(|value| value.len() > MAX_IDENTITY_BYTES)
        {
            return Err("event ID, run ID, and event type must not exceed 256 UTF-8 bytes");
        }
        if self.occurred_at > MAX_SAFE_INTEGER {
            return Err("event timestamp exceeds the supported range");
        }
        Ok(())
    }
}

/// Exact model configuration resolved for a caller-selected role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelection {
    /// Policy context; credentials remain harness-owned.
    pub context: String,
    /// Exact provider identifier.
    pub provider: String,
    /// Exact model identifier.
    pub model: String,
    /// Exact requested thinking level.
    pub thinking: String,
}

/// Resolved model configuration which adapters may snapshot for reproducibility.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingSnapshot {
    /// Execution profile selected by configuration.
    pub profile: String,
    /// Selected policy context.
    pub context: String,
    /// Resolved selections indexed by caller-defined role labels.
    pub routes: BTreeMap<String, Vec<ModelSelection>>,
}
