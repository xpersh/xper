//! Evidence relationships and cross-artifact validation for knowledge gates.
use crate::{
    ApplicationError,
    events::WorkOutcome,
    knowledge::{KnowledgeArtifact, KnowledgeOutput},
    ports::ArtifactReader,
    read_models::{ArtifactProjection, RunProjection},
};
use std::collections::BTreeSet;
use xper_domain::Phase;

pub(crate) fn phase(run: &RunProjection) -> Result<Phase, ApplicationError> {
    run.visits
        .last()
        .and_then(|v| Phase::knowledge(&v.phase))
        .filter(|p| p.contract().is_some())
        .ok_or(ApplicationError::InvalidInput("no active knowledge phase"))
}

pub(crate) fn inputs(run: &RunProjection) -> Vec<String> {
    let mut ids: Vec<_> = run.accepted.values().cloned().collect();
    if let Some(id) = &run.feedback {
        ids.push(id.clone());
    }
    ids.sort();
    ids.dedup();
    ids
}

pub(crate) fn output_path(phase: Phase, attempt: &str) -> String {
    if phase == Phase::Discovery {
        format!(".xper/artifacts/discovery-brief-{attempt}.md")
    } else {
        format!(
            ".xper/artifacts/{}-{attempt}.json",
            phase
                .contract()
                .expect("knowledge phase")
                .1
                .replace('_', "-")
        )
    }
}

pub(crate) fn current_artifact<'a>(
    run: &'a RunProjection,
    events: &[crate::events::Event],
) -> Option<&'a ArtifactProjection> {
    let visit = run.visits.last()?;
    let role = Phase::knowledge(&visit.phase)?.contract()?.0;
    events
        .iter()
        .rev()
        .filter_map(|e| match &e.kind {
            crate::events::EventKind::ArtifactRegistered { artifact_id, .. } => {
                run.artifacts.get(artifact_id)
            }
            _ => None,
        })
        .find(|artifact| {
            let attempt = &run.attempts[&artifact.attempt_id];
            let assignment = &run.assignments[&attempt.assignment_id];
            attempt.outcome == Some(WorkOutcome::Succeeded)
                && assignment.outcome == Some(WorkOutcome::Succeeded)
                && assignment.visit_id == visit.visit_id
                && assignment.role == role
        })
}

pub(crate) fn available(
    run: &RunProjection,
    artifact: &ArtifactProjection,
    reader: &impl ArtifactReader,
) -> bool {
    reader.is_available(&artifact.path).unwrap_or(false)
        && run.seals.get(&artifact.artifact_id).is_none_or(|expected| {
            reader.digest(&artifact.path).ok().flatten().as_ref() == Some(expected)
        })
}

pub(crate) fn document(
    run: &RunProjection,
    artifact: &ArtifactProjection,
    reader: &impl ArtifactReader,
) -> Result<KnowledgeArtifact, &'static str> {
    let (document, digest) = reader
        .read_contract(&artifact.path)
        .ok()
        .flatten()
        .ok_or("structured artifact is missing, unreadable, or invalid")?;
    if run.seals.get(&artifact.artifact_id) != Some(&digest) {
        return Err("artifact changed after registration");
    }
    let assignment = &run.attempts[&artifact.attempt_id].assignment_id;
    validate_inputs(
        &document,
        run.inputs.get(assignment).map_or(&[], Vec::as_slice),
    )?;
    Ok(document)
}

pub(crate) fn validate_inputs(
    document: &KnowledgeArtifact,
    expected: &[String],
) -> Result<(), &'static str> {
    let actual: BTreeSet<_> = document.inputs.iter().collect();
    if document.schema_version != 1
        || actual.len() != document.inputs.len()
        || actual != expected.iter().collect()
    {
        return Err("artifact version or input references do not match the assignment contract");
    }
    Ok(())
}

pub(crate) fn validate_links(
    output: &KnowledgeOutput,
    run: &RunProjection,
    reader: &impl ArtifactReader,
    elapsed_ms: u64,
) -> Result<(), &'static str> {
    let load = |phase: &str| {
        let id = run
            .accepted
            .get(phase)
            .ok_or("required upstream artifact has not passed its gate")?;
        document(run, &run.artifacts[id], reader)
    };
    match output {
        KnowledgeOutput::StoryMap { stories } => {
            let KnowledgeOutput::DefinitionContract { criteria, .. } = load("define")?.output
            else {
                return Err("invalid definition input");
            };
            let known: BTreeSet<_> = criteria.iter().map(|c| &c.id).collect();
            let covered: BTreeSet<_> = stories.iter().flat_map(|s| &s.criteria).collect();
            if known != covered {
                return Err("stories must cover every defined criterion without unknown criteria");
            }
        }
        KnowledgeOutput::ExecutionPlan { assignments } => {
            let KnowledgeOutput::StoryMap { stories } = load("breakdown")?.output else {
                return Err("invalid story map input");
            };
            if assignments
                .iter()
                .any(|a| !stories.iter().any(|s| s.id == a.increment_id))
            {
                return Err("plan references an unknown increment");
            }
            for story in &stories {
                let group: Vec<_> = assignments
                    .iter()
                    .filter(|a| a.increment_id == story.id)
                    .collect();
                for role in [
                    "implementation.driver",
                    "implementation.navigator",
                    "verify.verifier",
                ] {
                    if group.iter().filter(|a| a.role == role).count() != 1 {
                        return Err(
                            "each increment needs one driver, navigator, and independent verifier",
                        );
                    }
                }
                for assignment in &group {
                    let mut ancestors = BTreeSet::new();
                    let mut queue = assignment.dependencies.clone();
                    while let Some(id) = queue.pop() {
                        if ancestors.insert(id.clone()) {
                            queue.extend(
                                assignments
                                    .iter()
                                    .find(|a| a.id == id)
                                    .ok_or("unknown assignment dependency")?
                                    .dependencies
                                    .clone(),
                            );
                        }
                    }
                    for dependency in &story.dependencies {
                        let verifier = assignments
                            .iter()
                            .find(|a| a.increment_id == *dependency && a.role == "verify.verifier")
                            .ok_or("missing dependency verifier")?;
                        if !ancestors.contains(&verifier.id) {
                            return Err("assignment DAG omits an increment dependency");
                        }
                    }
                    if assignment.role == "verify.verifier"
                        && group
                            .iter()
                            .filter(|a| a.role != "verify.verifier")
                            .any(|a| !ancestors.contains(&a.id))
                    {
                        return Err("verification must depend on its driver and navigator");
                    }
                }
            }
            let attempts = assignments
                .iter()
                .fold(0u64, |sum, a| sum.saturating_add(u64::from(a.max_attempts)));
            let time = assignments
                .iter()
                .fold(0u64, |sum, a| sum.saturating_add(a.max_time_ms));
            let cost = assignments
                .iter()
                .fold(0u64, |sum, a| sum.saturating_add(a.max_cost_micros));
            if attempts
                > u64::from(run.policy.max_attempts).saturating_sub(run.attempts.len() as u64)
                || time > run.policy.max_time_ms.saturating_sub(elapsed_ms)
                || run.policy.max_cost_micros.is_some_and(|max| {
                    cost > max.saturating_sub(
                        run.charges
                            .values()
                            .fold(0u64, |sum, c| sum.saturating_add(*c)),
                    )
                })
            {
                return Err("execution plan exceeds remaining run budgets");
            }
        }
        _ => {}
    }
    Ok(())
}
