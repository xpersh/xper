import type { RemainingBudget, WorkflowPosition } from "../types.js";
import { invalid } from "../validation.js";
import type { VerificationState } from "./state.js";

export function verificationPosition(state: VerificationState): WorkflowPosition {
  const verdict = state.lifecycle.status === "completed" ? state.lifecycle.verdict : null;
  return {
    definitionId: state.definition.id,
    definitionVersion: state.definition.version,
    instanceId: state.instanceId,
    nodeId: verdict ?? "verify",
    phase: "verification",
    visitId: state.instanceId,
    status: state.lifecycle.status === "completed" ? "completed" : "active",
    activeAttemptIds: Object.entries(state.attempts)
      .filter(([, attempt]) => attempt.outcome === null)
      .map(([id]) => id),
    ...(state.lifecycle.status === "completed" ? { artifactId: state.lifecycle.artifactId } : {}),
  };
}

export function remainingLocal(state: VerificationState, now: number): RemainingBudget {
  const attempts = Object.keys(state.attempts).length;
  return {
    attempts: Math.max(0, state.assignment.maxAttempts - attempts),
    timeMs: Math.max(0, state.assignment.maxTimeMs - Math.max(0, now - state.startedAt)),
    costMicros: Math.max(0, state.assignment.maxCostMicros - attempts * state.attemptCostMicros),
    concurrency: 1,
  };
}

export function requireBudget(
  budget: RemainingBudget,
  cost: number,
  label: "verification" | "assignment" | "run",
): void {
  if (!budget.attempts) invalid(`${label} attempt budget exhausted`);
  if (!budget.timeMs) invalid(`${label} time budget exhausted`);
  if (budget.costMicros !== null && budget.costMicros < cost)
    invalid(`${label} cost budget exhausted`);
}
