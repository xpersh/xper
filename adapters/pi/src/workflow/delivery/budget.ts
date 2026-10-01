import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { ImplementationState } from "../implementation/state.js";
import type { PlannedAssignment } from "../knowledge/contract.js";
import { budgetRemaining } from "../policy.js";
import type { RemainingBudget } from "../types.js";
import type { VerificationState } from "../verification/state.js";
export function runBudget(checkpoint: AdapterCheckpoint, now: number) {
  const knowledge = checkpoint.knowledge;
  const attempts =
    Object.keys(knowledge.attempts).length +
    Object.values(checkpoint.implementations).reduce(
      (total, history) =>
        total +
        history.reduce(
          (subtotal, implementation) => subtotal + Object.keys(implementation.attempts).length,
          0,
        ),
      0,
    ) +
    Object.values(checkpoint.verifications).reduce(
      (total, history) =>
        total +
        history.reduce(
          (subtotal, verification) => subtotal + Object.keys(verification.attempts).length,
          0,
        ),
      0,
    );
  return budgetRemaining(knowledge.policy, knowledge.startedAt, now, attempts);
}
export function assignmentBudget(
  checkpoint: AdapterCheckpoint,
  assignment: PlannedAssignment,
  history: Array<ImplementationState | VerificationState>,
  now: number,
): RemainingBudget {
  const attempts = history.reduce((total, state) => total + Object.keys(state.attempts).length, 0);
  const startedAt = history[0]?.startedAt ?? now;
  const attemptCostMicros =
    history[0]?.attemptCostMicros ?? checkpoint.knowledge.policy.attemptCostMicros;
  return {
    attempts: Math.max(0, assignment.maxAttempts - attempts),
    timeMs: Math.max(0, assignment.maxTimeMs - Math.max(0, now - startedAt)),
    costMicros: Math.max(0, assignment.maxCostMicros - attempts * attemptCostMicros),
    concurrency: 1,
  };
}
export function assignmentHistory(
  checkpoint: AdapterCheckpoint,
  assignment: PlannedAssignment,
  kind: "implementation" | "verification",
): Array<ImplementationState | VerificationState> {
  const histories =
    kind === "implementation" ? checkpoint.implementations : checkpoint.verifications;
  return Object.values(histories)
    .flat()
    .filter(
      (state) => state.assignment.id === assignment.id && state.assignment.role === assignment.role,
    );
}
