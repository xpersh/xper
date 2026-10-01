import { invalid } from "../validation.js";
import { implementationDefinition } from "./definition.js";
import type { FactEmitter, ImplementationEvent, ImplementationResultByEvent } from "./events.js";
import { remainingLocal } from "./selectors.js";
import type { ImplementationState } from "./state.js";

export function startAssignment(
  state: ImplementationState | null,
  event: Extract<ImplementationEvent, { type: "assignment.start" }>,
  now: number,
  fact: FactEmitter,
): { state: ImplementationState; result: ImplementationResultByEvent["assignment.start"] } {
  if (!state) {
    state = {
      version: 1,
      revision: 0,
      runId: event.runId,
      definition: {
        id: implementationDefinition.id,
        version: implementationDefinition.version,
      },
      instanceId: event.instanceId,
      incrementId: event.assignment.incrementId,
      planArtifactId: event.planArtifactId,
      planDigest: event.planDigest,
      startedAt: now,
      baseCommit: event.baseCommit,
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
    fact("implementation.started", {
      incrementId: state.incrementId,
      assignmentId: state.assignment.id,
      planArtifactId: state.planArtifactId,
      baseCommit: state.baseCommit,
    });
    fact("assignment.created", {
      assignmentId: state.assignment.id,
      role: state.assignment.role,
      incrementId: state.incrementId,
      inputs: state.assignment.inputs,
    });
  }
  if (state.lifecycle.status === "completed")
    invalid("Verifier execution is not available yet; the increment is implemented");
  if (Object.values(state.attempts).some((attempt) => attempt.outcome === null))
    invalid("an implementation attempt is already running");
  const lastId = state.assignment.attemptIds.at(-1);
  const last = lastId ? state.attempts[lastId] : undefined;
  if (last?.outcome === "interrupted" && event.assignmentId !== state.assignment.id)
    invalid(`retry interrupted assignment ${state.assignment.id} explicitly`);
  if (event.assignmentId && event.assignmentId !== state.assignment.id)
    invalid("the requested implementation assignment is not eligible");
  const local = remainingLocal(state, now);
  if (!local.attempts) invalid("implementation attempt budget exhausted");
  if (!local.timeMs) invalid("implementation time budget exhausted");
  if (local.costMicros !== null && local.costMicros < state.attemptCostMicros)
    invalid("implementation cost budget exhausted");
  if (!event.globalBudget.attempts) invalid("run attempt budget exhausted");
  if (!event.globalBudget.timeMs) invalid("run time budget exhausted");
  if (
    event.globalBudget.costMicros !== null &&
    event.globalBudget.costMicros < state.attemptCostMicros
  )
    invalid("run cost budget exhausted");
  if (event.assignmentBudget) {
    if (!event.assignmentBudget.attempts)
      invalid("implementation assignment attempt budget exhausted");
    if (!event.assignmentBudget.timeMs) invalid("implementation assignment time budget exhausted");
    if (
      event.assignmentBudget.costMicros !== null &&
      event.assignmentBudget.costMicros < state.attemptCostMicros
    )
      invalid("implementation assignment cost budget exhausted");
  }
  if (state.attempts[event.attemptId]) invalid("attempt ID already exists");
  const timeoutMs = Math.min(
    state.attemptTimeMs,
    local.timeMs,
    event.assignmentBudget?.timeMs ?? Number.POSITIVE_INFINITY,
    event.globalBudget.timeMs,
  );
  const resultPath = `.xper/artifacts/implementation-result-${event.attemptId}.json`;
  const reservedCost = state.attemptCostMicros;
  const admissionBudgets = [
    local,
    ...(event.assignmentBudget ? [event.assignmentBudget] : []),
    event.globalBudget,
  ];
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
  return {
    state,
    result: {
      workflow: "implementation",
      runId: state.runId,
      assignmentId: state.assignment.id,
      attemptId: event.attemptId,
      role: state.assignment.role,
      selection: state.assignment.selection,
      ...(state.assignment.model ? { model: state.assignment.model } : {}),
      incrementId: state.incrementId,
      baseCommit: state.baseCommit,
      criteria: structuredClone(state.assignment.criteria),
      verification: [...state.assignment.verification],
      artifactKind: "implementation_result",
      artifactPath: resultPath,
      inputArtifacts: structuredClone(event.inputArtifacts),
      timeoutMs,
      budget: {
        attempts: Math.min(...admissionBudgets.map((budget) => budget.attempts - 1)),
        timeMs: timeoutMs,
        costMicros: Math.min(
          ...admissionBudgets
            .map((budget) => budget.costMicros)
            .filter((cost): cost is number => cost !== null)
            .map((cost) => Math.max(0, cost - reservedCost)),
        ),
        concurrency: 1,
      },
    },
  };
}
