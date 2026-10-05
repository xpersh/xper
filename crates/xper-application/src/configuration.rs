//! Configuration authoring values and explicit storage dependencies.

use std::collections::BTreeMap;

use serde_json::Value;

/// A configuration file's precedence and intended audience.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConfigurationScope {
    /// User-wide defaults.
    Global,
    /// Shared workspace configuration.
    Project,
    /// Private workspace overrides.
    Local,
}

/// One physical document, including invalid documents that can be repaired.
#[derive(Clone, Debug)]
pub struct ConfigurationDocument {
    /// Scope occupied by this document.
    pub scope: ConfigurationScope,
    /// Displayable destination supplied by infrastructure.
    pub path: String,
    /// Unmodified file contents, or none when the file does not exist.
    pub source: Option<String>,
    /// Parsed value when the document is valid.
    pub value: Option<Value>,
    /// A diagnostic that excludes credential values.
    pub error: Option<String>,
}

/// A consistent authoring view; it is not an active run's frozen routing.
#[derive(Clone, Debug)]
pub struct ConfigurationSnapshot {
    /// Physical documents in increasing precedence.
    pub documents: Vec<ConfigurationDocument>,
    /// Merged values, absent when a source document cannot be parsed.
    pub effective: Option<Value>,
    /// Authoring values merged through each valid scope, excluding higher overrides.
    pub scoped: BTreeMap<ConfigurationScope, Value>,
    /// Winning file scope for JSON-pointer paths in the merged value.
    pub origins: BTreeMap<String, ConfigurationScope>,
    /// YAML profile selected by scope precedence, before legacy workspace activation.
    pub default_profile: Option<String>,
    /// Legacy explicit workspace activation, if present; overrides every YAML scope.
    pub active_profile: Option<String>,
    /// Activation or the configured default.
    pub effective_profile: Option<String>,
    /// Source and routing problems available without failing the entire screen.
    pub diagnostics: Vec<String>,
    /// Opaque revision covering every scope and the activation file.
    pub revision: u64,
}

/// One intentional edit to the selected physical scope.
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigurationChange {
    /// Set a mapping value; an empty path explicitly replaces the document.
    Set {
        /// Mapping keys from the document root.
        path: Vec<String>,
        /// Value to store, without copying unrelated inherited settings.
        value: Value,
    },
    /// Remove this scope's override; lower scopes may become visible again.
    Remove {
        /// Mapping keys from the document root.
        path: Vec<String>,
    },
}

/// Validated content and its resulting effective configuration before saving.
#[derive(Clone, Debug)]
pub struct ConfigurationPreview {
    /// Snapshot revision used to compute this preview.
    pub revision: u64,
    /// Exact scoped edits reviewed by this preview.
    pub changes: Vec<ConfigurationChange>,
    /// Destination scope.
    pub scope: ConfigurationScope,
    /// Displayable destination.
    pub path: String,
    /// Proposed complete contents of that one physical document.
    pub source: String,
    /// Result after applying normal scope precedence.
    pub effective: Value,
    /// Result through the selected scope, before higher-precedence overrides.
    pub authoring: Value,
    /// Whether the destination would change.
    pub changed: bool,
    /// Nonblocking findings such as higher-precedence masking.
    pub diagnostics: Vec<String>,
}

/// Read, validate and commit authoring changes without terminal dependencies.
pub trait ConfigurationRepository {
    /// Failure supplied by the infrastructure implementation.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Inspect all sources without changing files.
    fn inspect(&self) -> Result<ConfigurationSnapshot, Self::Error>;

    /// Validate a proposed edit without changing files.
    fn preview(
        &self,
        snapshot: &ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: &[ConfigurationChange],
    ) -> Result<ConfigurationPreview, Self::Error>;

    /// Commit only when all inspected source revisions still match.
    fn save(
        &mut self,
        snapshot: &ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: &[ConfigurationChange],
    ) -> Result<ConfigurationSnapshot, Self::Error>;

    /// Activate a valid profile through the legacy workspace override, or clear it.
    /// Scoped selection uses preview/save with a set or removal of the YAML `profile` key.
    fn activate(&mut self, name: Option<&str>) -> Result<ConfigurationSnapshot, Self::Error>;
}
