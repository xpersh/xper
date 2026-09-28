//! Pure knowledge-phase contracts, dependency graphs, and resource limits.

use crate::Phase;
use std::collections::{BTreeMap, BTreeSet};

impl Phase {
    /// Parses a supported knowledge phase (including Intake).
    pub fn knowledge(name: &str) -> Option<Self> {
        match name {
            "intake" => Some(Self::Intake),
            "discovery" => Some(Self::Discovery),
            "define" => Some(Self::Define),
            "design" => Some(Self::Design),
            "breakdown" => Some(Self::Breakdown),
            "plan" => Some(Self::Plan),
            _ => None,
        }
    }

    /// Stable name used at the persistence boundary.
    pub fn name(self) -> &'static str {
        match self {
            Self::Intake => "intake",
            Self::Discovery => "discovery",
            Self::Define => "define",
            Self::Design => "design",
            Self::Breakdown => "breakdown",
            Self::Plan => "plan",
            Self::Implementation => "implementation",
            Self::Verify => "verify",
            Self::JudgmentDay => "judgment_day",
            Self::LearnClose => "learn_close",
        }
    }

    /// Required role and output artifact for an implemented phase.
    pub fn contract(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Discovery => Some(("discovery.explorer", "discovery_brief")),
            Self::Define => Some(("define.product", "definition_contract")),
            Self::Design => Some(("design.designer", "design_decisions")),
            Self::Breakdown => Some(("breakdown.slicer", "story_map")),
            Self::Plan => Some(("plan.planner", "execution_plan")),
            _ => None,
        }
    }

    /// Next knowledge gate; Plan deliberately has no executable successor yet.
    pub fn next_knowledge(self) -> Option<Self> {
        match self {
            Self::Discovery => Some(Self::Define),
            Self::Define => Some(Self::Design),
            Self::Design => Some(Self::Breakdown),
            Self::Breakdown => Some(Self::Plan),
            _ => None,
        }
    }
}

/// A dependency node with optional exclusive workspace/resource ownership.
#[derive(Debug)]
pub struct Node<'a> {
    /// Unique node key.
    pub id: &'a str,
    /// Keys that must complete before this node starts.
    pub dependencies: &'a [String],
    /// Logical workspace, empty for increment-only graphs.
    pub workspace: &'a str,
    /// Exclusive resource keys, including shared integration targets.
    pub resources: &'a [String],
}

/// Validate references and cycles, returning a deterministic topological order.
/// Unordered nodes cannot own the same workspace or exclusive resource.
pub fn validate_dag(nodes: &[Node<'_>]) -> Result<Vec<String>, &'static str> {
    if nodes.is_empty() || nodes.iter().any(|n| n.id.trim().is_empty()) {
        return Err("a nonempty DAG with named nodes is required");
    }
    let index: BTreeMap<_, _> = nodes.iter().map(|n| (n.id, n)).collect();
    if index.len() != nodes.len() {
        return Err("duplicate DAG node");
    }
    for node in nodes {
        let unique: BTreeSet<_> = node.dependencies.iter().collect();
        if unique.len() != node.dependencies.len()
            || node
                .dependencies
                .iter()
                .any(|d| d == node.id || !index.contains_key(d.as_str()))
        {
            return Err("unknown, duplicate, or self dependency");
        }
    }
    let mut order = Vec::new();
    let mut ancestors: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    while order.len() < nodes.len() {
        let Some(node) = index.values().find(|node| {
            !ancestors.contains_key(node.id)
                && node
                    .dependencies
                    .iter()
                    .all(|d| ancestors.contains_key(d.as_str()))
        }) else {
            return Err("dependency cycle");
        };
        let mut reachable = BTreeSet::new();
        for dependency in node.dependencies {
            reachable.insert(dependency.as_str());
            reachable.extend(&ancestors[dependency.as_str()]);
        }
        ancestors.insert(node.id, reachable);
        order.push(node.id.to_owned());
    }
    for (i, a) in nodes.iter().enumerate() {
        for b in &nodes[i + 1..] {
            let conflict = (!a.workspace.is_empty() && a.workspace == b.workspace)
                || a.resources.iter().any(|r| b.resources.contains(r));
            if conflict && !ancestors[a.id].contains(b.id) && !ancestors[b.id].contains(a.id) {
                return Err("unordered assignments have a workspace or resource conflict");
            }
        }
    }
    Ok(order)
}

/// Resource policy checked before dispatching an attempt.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    /// Maximum physical attempts across all visits.
    pub attempts: u32,
    /// Maximum elapsed run time, including human waits.
    pub time_ms: u64,
    /// Maximum simultaneous physical attempts.
    pub concurrency: u32,
    /// Optional run cost ceiling in micro currency units.
    pub cost_micros: Option<u64>,
    /// Conservative amount reserved for each attempt.
    pub attempt_cost_micros: u64,
}

impl Budget {
    /// Reject exhausted limits; all arithmetic saturates to prevent wraparound.
    pub fn check(
        self,
        attempts: usize,
        running: usize,
        elapsed_ms: u64,
        charged: u64,
    ) -> Result<(), &'static str> {
        if attempts >= self.attempts as usize {
            return Err("run attempt budget exhausted");
        }
        if elapsed_ms >= self.time_ms {
            return Err("run time budget exhausted");
        }
        if running >= self.concurrency as usize {
            return Err("run concurrency budget exhausted");
        }
        if self
            .cost_micros
            .is_some_and(|max| charged.saturating_add(self.attempt_cost_micros) > max)
        {
            return Err("run cost budget exhausted");
        }
        Ok(())
    }
}
