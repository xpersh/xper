//! Versioned artifact documents and frozen workflow policy. Content stays in files.

use serde::{Deserialize, Serialize};
use xper_domain::{
    Phase,
    planning::{Budget, Node, validate_dag},
};

/// Run limits and phases requiring explicit human approval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowPolicy {
    /// Physical attempts across the run, including retries and revisits.
    pub max_attempts: u32,
    /// Wall time from run start, including waiting for humans.
    pub max_time_ms: u64,
    /// Per-attempt timeout returned to the adapter.
    pub attempt_time_ms: u64,
    /// Maximum running attempts across this run.
    pub max_concurrency: u32,
    /// Optional cost ceiling in micro currency units.
    pub max_cost_micros: Option<u64>,
    /// Conservative cost reservation per invocation (required with a ceiling).
    pub attempt_cost_micros: u64,
    /// Gates requiring a human decision for each visit and artifact.
    pub human_gates: Vec<String>,
}

impl Default for WorkflowPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 32,
            max_time_ms: 3_600_000,
            attempt_time_ms: 120_000,
            max_concurrency: 4,
            max_cost_micros: None,
            attempt_cost_micros: 0,
            human_gates: vec![],
        }
    }
}

impl WorkflowPolicy {
    /// Validate configuration before committing the run.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.max_attempts == 0
            || self.max_time_ms == 0
            || self.attempt_time_ms == 0
            || self.attempt_time_ms > self.max_time_ms
            || self.max_concurrency == 0
            || self
                .max_cost_micros
                .is_some_and(|max| self.attempt_cost_micros == 0 || self.attempt_cost_micros > max)
            || self
                .human_gates
                .iter()
                .any(|p| Phase::knowledge(p).and_then(Phase::contract).is_none())
        {
            return Err("invalid workflow budgets or human gates");
        }
        Ok(())
    }
    /// Pure domain budget used for admission.
    pub fn budget(&self) -> Budget {
        Budget {
            attempts: self.max_attempts,
            time_ms: self.max_time_ms,
            concurrency: self.max_concurrency,
            cost_micros: self.max_cost_micros,
            attempt_cost_micros: self.attempt_cost_micros,
        }
    }
}

/// Remaining limits supplied with artifact inputs for planning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemainingBudget {
    /// Attempts available after this dispatch.
    pub attempts: u32,
    /// Wall time available at dispatch.
    pub time_ms: u64,
    /// Optional cost remaining after reserving this dispatch.
    pub cost_micros: Option<u64>,
    /// Maximum simultaneous attempts.
    pub concurrency: u32,
}

/// A versioned document produced by a knowledge assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KnowledgeArtifact {
    /// Artifact contract version; currently exactly one.
    pub schema_version: u32,
    /// Identities of all input artifacts returned by assignment.start.
    pub inputs: Vec<String>,
    /// Structured phase output or evidence-backed feedback.
    pub output: KnowledgeOutput,
}

/// Phase output fields. Semantic gates are evaluated by the core.
#[allow(missing_docs)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum KnowledgeOutput {
    DefinitionContract {
        goal: String,
        scope: Vec<String>,
        exclusions: Vec<String>,
        criteria: Vec<Criterion>,
    },
    DesignDecisions {
        approach: String,
        interfaces: Vec<String>,
        alternatives: Vec<String>,
        risks: Vec<String>,
        feasible: bool,
    },
    StoryMap {
        stories: Vec<Story>,
    },
    ExecutionPlan {
        assignments: Vec<PlannedAssignment>,
    },
    Feedback {
        reason: FeedbackReason,
        evidence: String,
    },
}

/// Explicit uncertainty origin; never inferred from transcripts.
#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackReason {
    MissingContext,
    AmbiguousCriteria,
    InfeasibleDesign,
    OversizedStory,
}

impl FeedbackReason {
    /// Phase responsible for resolving this uncertainty.
    pub fn target(self) -> Phase {
        match self {
            Self::MissingContext => Phase::Discovery,
            Self::AmbiguousCriteria => Phase::Define,
            Self::InfeasibleDesign => Phase::Design,
            Self::OversizedStory => Phase::Breakdown,
        }
    }
}

/// Observable criterion and concrete example.
#[allow(missing_docs)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Criterion {
    pub id: String,
    pub behavior: String,
    pub example: String,
}

/// A vertical, independently verifiable increment.
#[allow(missing_docs)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Story {
    pub id: String,
    pub value: String,
    pub criteria: Vec<String>,
    pub verification: Vec<String>,
    pub independently_verifiable: bool,
    pub dependencies: Vec<String>,
}

/// A planned assignment; no attempt or workspace is created by this record.
#[allow(missing_docs)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlannedAssignment {
    pub id: String,
    pub increment_id: String,
    pub role: String,
    pub dependencies: Vec<String>,
    pub workspace: String,
    pub resources: Vec<String>,
    pub max_attempts: u32,
    pub max_time_ms: u64,
    pub max_cost_micros: u64,
}

fn text(value: &str) -> bool {
    !value.trim().is_empty()
}
fn texts(values: &[String]) -> bool {
    !values.is_empty() && values.iter().all(|v| text(v))
}

impl KnowledgeOutput {
    /// Output kind used in the public contract.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::DefinitionContract { .. } => "definition_contract",
            Self::DesignDecisions { .. } => "design_decisions",
            Self::StoryMap { .. } => "story_map",
            Self::ExecutionPlan { .. } => "execution_plan",
            Self::Feedback { .. } => "feedback",
        }
    }

    /// Minimum evidence and independent graph invariants; cross-artifact links
    /// are checked separately using the assignment's frozen inputs.
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::DefinitionContract {
                goal,
                scope,
                exclusions,
                criteria,
            } => {
                text(goal)
                    && texts(scope)
                    && exclusions.iter().all(|e| text(e))
                    && !criteria.is_empty()
                    && criteria
                        .iter()
                        .all(|c| text(&c.id) && text(&c.behavior) && text(&c.example))
                    && criteria
                        .iter()
                        .map(|c| &c.id)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        == criteria.len()
            }
            Self::DesignDecisions {
                approach,
                interfaces,
                alternatives,
                risks,
                ..
            } => {
                text(approach)
                    && texts(interfaces)
                    && texts(alternatives)
                    && risks.iter().all(|r| text(r))
            }
            Self::StoryMap { stories } => {
                if stories.iter().any(|s| {
                    !s.independently_verifiable
                        || !text(&s.value)
                        || !texts(&s.criteria)
                        || !texts(&s.verification)
                }) {
                    return Err(
                        "each story must deliver value and be independently verifiable against criteria",
                    );
                }
                validate_dag(
                    &stories
                        .iter()
                        .map(|s| Node {
                            id: &s.id,
                            dependencies: &s.dependencies,
                            workspace: "",
                            resources: &[],
                        })
                        .collect::<Vec<_>>(),
                )?;
                true
            }
            Self::ExecutionPlan { assignments } => {
                if assignments.iter().any(|a| {
                    !text(&a.increment_id)
                        || !matches!(
                            a.role.as_str(),
                            "implementation.driver"
                                | "implementation.navigator"
                                | "verify.verifier"
                        )
                        || !text(&a.workspace)
                        || !a
                            .workspace
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                        || a.resources.iter().any(|r| !text(r))
                        || a.max_attempts == 0
                        || a.max_time_ms == 0
                }) {
                    return Err(
                        "plan assignments need an increment, delivery role, workspace identifier, and positive budgets",
                    );
                }
                validate_dag(
                    &assignments
                        .iter()
                        .map(|a| Node {
                            id: &a.id,
                            dependencies: &a.dependencies,
                            workspace: &a.workspace,
                            resources: &a.resources,
                        })
                        .collect::<Vec<_>>(),
                )?;
                true
            }
            Self::Feedback { evidence, .. } => text(evidence),
        };
        if valid {
            Ok(())
        } else {
            Err("artifact does not satisfy its minimum phase contract")
        }
    }
}
