//! Harness-neutral installation diagnostics returned by local adapters.

/// Severity of an installation check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckStatus {
    /// The requirement is satisfied.
    Pass,
    /// A degradation or optional preparation remains.
    Warn,
    /// The requirement is not satisfied.
    Fail,
}

/// One stable diagnostic, with evidence and an optional corrective action.
#[derive(Debug)]
pub struct Check {
    /// Stable diagnostic identifier.
    pub id: &'static str,
    /// Severity of the finding.
    pub status: CheckStatus,
    /// Human-readable evidence supplied by the adapter.
    pub evidence: String,
    /// Suggested correction, when available.
    pub action: Option<String>,
}

impl Check {
    /// Creates a diagnostic that must pass before initialization can proceed.
    pub fn new(
        id: &'static str,
        status: CheckStatus,
        evidence: impl Into<String>,
        action: Option<&str>,
    ) -> Self {
        Self {
            id,
            status,
            evidence: evidence.into(),
            action: action.map(str::to_owned),
        }
    }
}
