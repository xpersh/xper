use super::*;
use crate::events::{Event, EventKind};

/// Replays ordered events for a single run and rejects inconsistent histories.
pub fn replay(events: &[Event]) -> Result<Option<RunProjection>, String> {
    let mut run: Option<RunProjection> = None;
    for event in events {
        if event.event_id.trim().is_empty() || event.run_id.trim().is_empty() {
            return Err("empty event or run identifier".into());
        }
        if let EventKind::RunStarted { metadata, routing } = &event.kind {
            if run.is_some()
                || metadata.adapter.trim().is_empty()
                || metadata.version.trim().is_empty()
                || routing.as_ref().is_some_and(|snapshot| {
                    snapshot.profile.trim().is_empty()
                        || snapshot.context.trim().is_empty()
                        || snapshot.routes.is_empty()
                        || snapshot.routes.values().any(|candidates| {
                            candidates.is_empty()
                                || candidates.iter().any(|selection| {
                                    selection.context != snapshot.context
                                        || selection.provider.trim().is_empty()
                                        || selection.model.trim().is_empty()
                                })
                        })
                })
            {
                return Err("duplicate run start or invalid run metadata/routing".into());
            }
            run = Some(RunProjection {
                run_id: event.run_id.clone(),
                status: RunStatus::Active,
                metadata: metadata.clone(),
                routing: routing.clone(),
                visits: Vec::new(),
                gates: BTreeMap::new(),
                assignments: BTreeMap::new(),
                attempts: BTreeMap::new(),
                artifacts: BTreeMap::new(),
            });
            continue;
        }
        let state = run.as_mut().ok_or("event before run start")?;
        if state.run_id != event.run_id {
            return Err("mixed run identifiers".into());
        }
        match &event.kind {
            EventKind::RunStarted { .. } => unreachable!(),
            EventKind::RunSuspended if state.status == RunStatus::Active => {
                state.status = RunStatus::Suspended
            }
            EventKind::RunResumed if state.status == RunStatus::Suspended => {
                state.status = RunStatus::Active
            }
            EventKind::RunCompleted if state.status == RunStatus::Active => {
                state.status = RunStatus::Completed
            }
            EventKind::RunFailed
                if matches!(state.status, RunStatus::Active | RunStatus::Suspended) =>
            {
                state.status = RunStatus::Failed
            }
            EventKind::PhaseEntered {
                visit_id,
                phase,
                visit_number,
            }
            | EventKind::PhaseRevisited {
                visit_id,
                phase,
                visit_number,
            } => {
                if state.status != RunStatus::Active
                    || visit_id.trim().is_empty()
                    || phase.trim().is_empty()
                    || *visit_number == 0
                    || state.visits.iter().any(|v| v.visit_id == *visit_id)
                    || state
                        .visits
                        .last()
                        .is_some_and(|v| v.exited_at_ms.is_none())
                    || state.visits.iter().filter(|v| v.phase == *phase).count() + 1
                        != *visit_number as usize
                    || matches!(event.kind, EventKind::PhaseEntered { .. }) != (*visit_number == 1)
                {
                    return Err("invalid phase entry".into());
                }
                state.visits.push(VisitProjection {
                    visit_id: visit_id.clone(),
                    phase: phase.clone(),
                    visit_number: *visit_number,
                    entered_at_ms: event.occurred_at_ms,
                    exited_at_ms: None,
                    exit_gate_id: None,
                });
            }
            EventKind::PhaseExited {
                visit_id,
                phase,
                gate_id,
            } => {
                let visit = state.visits.last_mut().ok_or("phase exit before entry")?;
                if state.status != RunStatus::Active
                    || visit.visit_id != *visit_id
                    || visit.phase != *phase
                    || visit.exited_at_ms.is_some()
                    || event.occurred_at_ms < visit.entered_at_ms
                    || gate_id.trim().is_empty()
                    || !state
                        .gates
                        .get(gate_id)
                        .is_some_and(|gate| gate.passed && gate.visit_id == *visit_id)
                {
                    return Err("invalid phase exit".into());
                }
                visit.exited_at_ms = Some(event.occurred_at_ms);
                visit.exit_gate_id = Some(gate_id.clone());
            }
            EventKind::GateEvaluated {
                visit_id,
                gate_id,
                outcome,
            } => {
                if gate_id.trim().is_empty()
                    || state.gates.contains_key(gate_id)
                    || !state.visits.last().is_some_and(|visit| {
                        visit.visit_id == *visit_id && visit.exited_at_ms.is_none()
                    })
                {
                    return Err("gate references unknown or exited visit".into());
                }
                state.gates.insert(
                    gate_id.clone(),
                    GateProjection {
                        gate_id: gate_id.clone(),
                        visit_id: visit_id.clone(),
                        outcome: *outcome,
                        evaluated_at_ms: event.occurred_at_ms,
                        passed: false,
                    },
                );
            }
            EventKind::GatePassed { visit_id, gate_id } => {
                if state
                    .visits
                    .last()
                    .is_some_and(|visit| visit.phase == "discovery")
                    && state.assignments.values().any(|assignment| {
                        assignment.visit_id == *visit_id && assignment.outcome.is_none()
                    })
                {
                    return Err("Discovery assignments are still running".into());
                }
                let gate = state
                    .gates
                    .get_mut(gate_id)
                    .ok_or("gate pass before evaluation")?;
                if gate.visit_id != *visit_id || gate.outcome != GateOutcome::Passed || gate.passed
                {
                    return Err("invalid gate pass".into());
                }
                gate.passed = true;
            }
            EventKind::AssignmentCreated {
                assignment_id,
                visit_id,
                role,
            } => {
                if assignment_id.trim().is_empty()
                    || role.trim().is_empty()
                    || state.assignments.contains_key(assignment_id)
                    || !state
                        .visits
                        .last()
                        .is_some_and(|v| v.visit_id == *visit_id && v.exited_at_ms.is_none())
                {
                    return Err("invalid assignment".into());
                }
                state.assignments.insert(
                    assignment_id.clone(),
                    AssignmentProjection {
                        assignment_id: assignment_id.clone(),
                        visit_id: visit_id.clone(),
                        role: role.clone(),
                        outcome: None,
                    },
                );
            }
            EventKind::AssignmentCompleted {
                assignment_id,
                outcome,
            } => {
                let assignment = state
                    .assignments
                    .get_mut(assignment_id)
                    .ok_or("unknown assignment")?;
                if assignment.outcome.is_some() {
                    return Err("assignment already completed".into());
                }
                assignment.outcome = Some(*outcome);
            }
            EventKind::AttemptStarted {
                attempt_id,
                assignment_id,
                selection,
            } => {
                if attempt_id.trim().is_empty()
                    || state.attempts.contains_key(attempt_id)
                    || !state.assignments.contains_key(assignment_id)
                    || match (&state.routing, selection) {
                        (Some(routing), Some(selection)) => {
                            let assignment = &state.assignments[assignment_id];
                            !routing
                                .routes
                                .get(&assignment.role)
                                .is_some_and(|candidates| candidates.contains(selection))
                        }
                        (None, None) => false,
                        _ => true,
                    }
                {
                    return Err("invalid attempt".into());
                }
                let ordinal = state
                    .attempts
                    .values()
                    .filter(|attempt| attempt.assignment_id == *assignment_id)
                    .count() as u32
                    + 1;
                state.attempts.insert(
                    attempt_id.clone(),
                    AttemptProjection {
                        attempt_id: attempt_id.clone(),
                        assignment_id: assignment_id.clone(),
                        ordinal,
                        selection: selection.clone(),
                        started_at_ms: event.occurred_at_ms,
                        finished_at_ms: None,
                        outcome: None,
                    },
                );
            }
            EventKind::AttemptFinished {
                attempt_id,
                outcome,
            } => {
                let attempt = state
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or("unknown attempt")?;
                if attempt.outcome.is_some() || event.occurred_at_ms < attempt.started_at_ms {
                    return Err("attempt already finished or timestamp before start".into());
                }
                attempt.outcome = Some(*outcome);
                attempt.finished_at_ms = Some(event.occurred_at_ms);
            }
            EventKind::ArtifactRegistered {
                artifact_id,
                attempt_id,
                kind,
                path,
                version,
            } => {
                if artifact_id.trim().is_empty()
                    || state.artifacts.contains_key(artifact_id)
                    || kind.trim().is_empty()
                    || path.trim().is_empty()
                    || *version == 0
                    || !state
                        .attempts
                        .get(attempt_id)
                        .is_some_and(|attempt| attempt.outcome == Some(WorkOutcome::Succeeded))
                {
                    return Err("invalid artifact registration".into());
                }
                state.artifacts.insert(
                    artifact_id.clone(),
                    ArtifactProjection {
                        artifact_id: artifact_id.clone(),
                        attempt_id: attempt_id.clone(),
                        kind: kind.clone(),
                        path: path.clone(),
                        version: *version,
                    },
                );
            }
            _ => return Err("invalid run lifecycle transition".into()),
        }
    }
    Ok(run)
}
