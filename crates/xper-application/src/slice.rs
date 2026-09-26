//! Policy for the first evidence-backed Discovery gate.

use crate::events::{RunProjection, WorkOutcome};

/// Returns whether the current Discovery visit has a usable Brief produced by
/// a successful explorer assignment. The caller verifies artifact availability
/// through a port so this policy never touches a filesystem or harness API.
pub fn discovery_ready(
    run: &RunProjection,
    mut artifact_available: impl FnMut(&str) -> bool,
) -> bool {
    let Some(visit) = run
        .visits
        .last()
        .filter(|visit| visit.phase == "discovery" && visit.exited_at_ms.is_none())
    else {
        return false;
    };
    run.artifacts.values().any(|artifact| {
        artifact.kind == "discovery_brief"
            && artifact.version > 0
            && artifact_available(&artifact.path)
            && run
                .attempts
                .get(&artifact.attempt_id)
                .is_some_and(|attempt| {
                    attempt.outcome == Some(WorkOutcome::Succeeded)
                        && run
                            .assignments
                            .get(&attempt.assignment_id)
                            .is_some_and(|assignment| {
                                assignment.visit_id == visit.visit_id
                                    && assignment.role == "discovery.explorer"
                                    && assignment.outcome == Some(WorkOutcome::Succeeded)
                            })
                })
    })
}
