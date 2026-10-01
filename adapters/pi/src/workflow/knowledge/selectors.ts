import { budgetRemaining } from "../policy.js";
import type { FinishAttempt, WorkflowPosition } from "../types.js";
import { invalid } from "../validation.js";
import { currentVisit, type WorkflowState } from "./state.js";

export function remainingBudget(state: WorkflowState, now: number) {
  return budgetRemaining(state.policy, state.startedAt, now, Object.keys(state.attempts).length);
}

export function attemptOutcome(state: WorkflowState, result: FinishAttempt, now: number) {
  const attempt = state.attempts[result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  return result.outcome === "succeeded" &&
    (now - attempt.startedAt >= attempt.timeoutMs || !remainingBudget(state, now).timeMs)
    ? "timed_out"
    : result.outcome;
}

export function completionNeedsEvidence(
  state: WorkflowState,
  result: FinishAttempt,
  now: number,
): boolean {
  const attempt = state.attempts[result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  if (result.outcome === "succeeded" && result.artifactPath !== attempt.artifactPath)
    invalid("artifact path does not match the assignment");
  return attempt.outcome === null && attemptOutcome(state, result, now) === "succeeded";
}

export function gateArtifact(state: WorkflowState) {
  const visit = currentVisit(state);
  return Object.values(state.artifacts)
    .reverse()
    .find((artifact) => {
      const attempt = state.attempts[artifact.attemptId];
      return (
        attempt?.outcome === "succeeded" &&
        state.assignments[attempt.assignmentId]?.visitId === visit.id
      );
    });
}

export function workflowPosition(state: WorkflowState): WorkflowPosition {
  const visit = currentVisit(state);
  return {
    definitionId: state.definition.id,
    definitionVersion: state.definition.version,
    instanceId: state.instanceId,
    nodeId: state.lifecycle.status === "completed" ? "ready" : visit.phase,
    phase: visit.phase,
    visitId: visit.id,
    status: state.lifecycle.status,
    activeAttemptIds: Object.entries(state.attempts)
      .filter(([, attempt]) => attempt.outcome === null)
      .map(([id]) => id),
    ...(state.lifecycle.status === "awaiting_approval"
      ? { artifactId: state.lifecycle.artifactId }
      : {}),
  };
}
