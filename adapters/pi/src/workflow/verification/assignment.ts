import type { RemainingBudget } from "../types.js";
import { invalid } from "../validation.js";
import { verificationDefinition } from "./definition.js";
import type { FactEmitter, Results, VerificationEvent } from "./events.js";
import { remainingLocal, requireBudget } from "./selectors.js";
import type { VerificationState } from "./state.js";

export function startAssignment(
  state: VerificationState | null,
  event: Extract<VerificationEvent, { type: "assignment.start" }>,
  now: number,
  fact: FactEmitter,
): { state: VerificationState; result: Results["assignment.start"] } {
  if (!state) {
    state = {
      version: 1,
      revision: 0,
      runId: event.runId,
      definition: { id: verificationDefinition.id, version: verificationDefinition.version },
      instanceId: event.instanceId,
      incrementId: event.assignment.incrementId,
      planArtifactId: event.planArtifactId,
      planDigest: event.planDigest,
      startedAt: now,
      implementation: structuredClone(event.implementation),
      assignment: {
        ...structuredClone(event.assignment),
        inputs: [...event.inputs],
        criteria: structuredClone(event.criteria),
        verification: [...event.verification],
        selection: structuredClone(event.selection),
        model: event.model,
        attemptIds: [],
      },
      attemptTimeMs: event.attemptTimeMs,
      attemptCostMicros: event.attemptCostMicros,
      attempts: {},
      artifacts: {},
      lifecycle: { status: "active" },
    };
    fact("verification.started", {
      incrementId: state.incrementId,
      assignmentId: state.assignment.id,
      implementationArtifactId: state.implementation.artifactId,
      evaluatedCommit: state.implementation.evaluatedCommit,
    });
    fact("assignment.created", {
      assignmentId: state.assignment.id,
      role: state.assignment.role,
      incrementId: state.incrementId,
      inputs: state.assignment.inputs,
    });
  }
  if (state.lifecycle.status === "completed") invalid("the verification is already complete");
  if (Object.values(state.attempts).some((attempt) => attempt.outcome === null))
    invalid("a verification attempt is already running");
  const lastId = state.assignment.attemptIds.at(-1);
  const last = lastId ? state.attempts[lastId] : undefined;
  if (last?.outcome === "interrupted" && event.assignmentId !== state.assignment.id)
    invalid(`retry interrupted assignment ${state.assignment.id} explicitly`);
  if (event.assignmentId && event.assignmentId !== state.assignment.id)
    invalid("the requested verification assignment is not eligible");
  const local = remainingLocal(state, now);
  requireBudget(local, state.attemptCostMicros, "verification");
  requireBudget(event.assignmentBudget, state.attemptCostMicros, "assignment");
  requireBudget(event.globalBudget, state.attemptCostMicros, "run");
  if (state.attempts[event.attemptId]) invalid("attempt ID already exists");
  const timeoutMs = Math.min(
    state.attemptTimeMs,
    local.timeMs,
    event.assignmentBudget.timeMs,
    event.globalBudget.timeMs,
  );
  const resultPath = `.xper/artifacts/verification-result-${event.attemptId}.json`;
  state.attempts[event.attemptId] = {
    startedAt: now,
    timeoutMs,
    outcome: null,
    artifactId: null,
    artifactPath: resultPath,
    selection: structuredClone(state.assignment.selection),
    model: state.assignment.model,
  };
  state.assignment.attemptIds.push(event.attemptId);
  fact("attempt.started", {
    attemptId: event.attemptId,
    assignmentId: state.assignment.id,
    role: state.assignment.role,
    incrementId: state.incrementId,
    selection: state.assignment.selection,
    model: state.assignment.model,
    timeoutMs,
  });
  const attemptCostMicros = state.attemptCostMicros;
  const remainingCost = (budget: RemainingBudget) =>
    budget.costMicros === null ? null : Math.max(0, budget.costMicros - attemptCostMicros);
  const costs = [
    remainingCost(local),
    remainingCost(event.assignmentBudget),
    remainingCost(event.globalBudget),
  ];
  return {
    state,
    result: {
      workflow: "verification",
      runId: state.runId,
      assignmentId: state.assignment.id,
      attemptId: event.attemptId,
      role: state.assignment.role,
      selection: state.assignment.selection,
      ...(state.assignment.model ? { model: state.assignment.model } : {}),
      incrementId: state.incrementId,
      implementationArtifactId: state.implementation.artifactId,
      baseCommit: state.implementation.baseCommit,
      evaluatedCommit: state.implementation.evaluatedCommit,
      implementationTestCommands: [...state.implementation.testCommands],
      criteria: structuredClone(state.assignment.criteria),
      verification: [...state.assignment.verification],
      artifactKind: "verification_result",
      artifactPath: resultPath,
      inputArtifacts: structuredClone(event.inputArtifacts),
      timeoutMs,
      budget: {
        attempts: Math.min(
          local.attempts - 1,
          event.assignmentBudget.attempts - 1,
          event.globalBudget.attempts - 1,
        ),
        timeMs: timeoutMs,
        costMicros: costs.includes(null)
          ? Math.min(...costs.filter((cost): cost is number => cost !== null))
          : Math.min(...(costs as number[])),
        concurrency: 1,
      },
    },
  };
}
