import type { RemainingBudget, WorkflowPosition } from "../types.js";
import type { ImplementationState } from "./state.js";

export function implementationPosition(state: ImplementationState): WorkflowPosition {
  return {
    definitionId: state.definition.id,
    definitionVersion: state.definition.version,
    instanceId: state.instanceId,
    nodeId: state.lifecycle.status === "completed" ? "implemented" : "implement",
    phase: "implementation",
    visitId: state.instanceId,
    status: state.lifecycle.status === "completed" ? "completed" : "active",
    activeAttemptIds: Object.entries(state.attempts)
      .filter(([, attempt]) => attempt.outcome === null)
      .map(([id]) => id),
    ...(state.lifecycle.status === "completed" ? { artifactId: state.lifecycle.artifactId } : {}),
  };
}

export function remainingLocal(state: ImplementationState, now: number): RemainingBudget {
  const attempts = Object.keys(state.attempts).length;
  return {
    attempts: Math.max(0, state.assignment.maxAttempts - attempts),
    timeMs: Math.max(0, state.assignment.maxTimeMs - Math.max(0, now - state.startedAt)),
    costMicros: Math.max(0, state.assignment.maxCostMicros - attempts * state.attemptCostMicros),
    concurrency: 1,
  };
}
