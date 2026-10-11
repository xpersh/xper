import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { ImplementationState } from "../implementation/state.js";
import type { PlannedAssignment } from "../knowledge/contract.js";
import { budgetRemaining } from "../policy.js";
import { satisfiedAssignmentArtifacts } from "./frontier.js";
import type { RemainingBudget } from "../types.js";
import type { VerificationState } from "../verification/state.js";
export function runBudget(checkpoint: AdapterCheckpoint, now: number) {
  const knowledge = checkpoint.knowledge;
  const attempts =
    Object.keys(knowledge.attempts).length +
    Object.keys(checkpoint.judgment?.attempts ?? {}).length +
    checkpoint.judgmentHistory.reduce(
      (total, entry) => total + Object.keys(entry.state.attempts).length,
      0,
    ) +
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

export function unresolvedBudgetReason(checkpoint: AdapterCheckpoint, now: number): string | null {
  const cost = checkpoint.knowledge.policy.attemptCostMicros;
  const exhausted = (budget: RemainingBudget, label: string) =>
    !budget.attempts
      ? `${label} attempt budget exhausted`
      : !budget.timeMs
        ? `${label} time budget exhausted`
        : budget.costMicros !== null && budget.costMicros < cost
          ? `${label} cost budget exhausted`
          : null;
  const global = exhausted(runBudget(checkpoint, now), "run");
  if (global || checkpoint.knowledge.lifecycle.status !== "completed") return global;
  const satisfied = satisfiedAssignmentArtifacts(checkpoint);
  for (const kind of ["implementation", "verification"] as const) {
    const histories =
      kind === "implementation" ? checkpoint.implementations : checkpoint.verifications;
    for (const history of Object.values(histories)) {
      const latest = history.findLast(
        (state: ImplementationState | VerificationState) =>
          state.planArtifactId === checkpoint.authorizedPlan?.artifactId,
      );
      if (!latest || satisfied.has(latest.assignment.id)) continue;
      const reason = exhausted(
        assignmentBudget(
          checkpoint,
          latest.assignment,
          assignmentHistory(checkpoint, latest.assignment, kind),
          now,
        ),
        `${kind} assignment ${latest.assignment.id}`,
      );
      if (reason) return reason;
    }
  }
  return null;
}
