import { object } from "../bridge/xper-client.js";
import type { ModelSelection } from "../bridge/xper-client.js";
import type { PlannedAssignment } from "./contracts.js";
import { implementationDefinition } from "./definition.js";
import type {
  AttemptFinished,
  ArtifactInput,
  FinishAttempt,
  ImplementationAssignmentStarted,
  ImplementationCriterion,
  RemainingBudget,
  WorkflowPosition,
} from "./types.js";
import { WorkflowValidationError } from "./types.js";

export interface ImplementationTestResult {
  command: string;
  exitCode: number;
  outputPath: string;
}

export interface ImplementationResult {
  schemaVersion: 1;
  inputs: string[];
  output: {
    kind: "implementation_result";
    assignmentId: string;
    incrementId: string;
    baseCommit: string;
    resultingCommit: string;
    changedFiles: string[];
    tests: ImplementationTestResult[];
    criteria: Array<{ criterionId: string; evidence: string; paths: string[] }>;
  };
}

export interface ImplementationAttempt {
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
  model: string | null;
}

export interface ImplementationArtifact {
  artifact_id: string;
  attemptId: string;
  kind: "implementation_result";
  path: string;
  version: 1;
  digest: string;
  inputs: string[];
}

export interface ImplementationState {
  version: 1;
  revision: number;
  runId: string;
  definition: { id: string; version: number };
  instanceId: string;
  incrementId: string;
  planArtifactId: string;
  planDigest: string;
  startedAt: number;
  baseCommit: string;
  assignment: PlannedAssignment & {
    inputs: string[];
    criteria: ImplementationCriterion[];
    verification: string[];
    selection: ModelSelection | null;
    model: string | null;
    attemptIds: string[];
  };
  attemptTimeMs: number;
  attemptCostMicros: number;
  attempts: Record<string, ImplementationAttempt>;
  artifacts: Record<string, ImplementationArtifact>;
  lifecycle: { status: "active" } | { status: "completed"; artifactId: string };
}

export interface ImplementationFact {
  type: string;
  data: Record<string, unknown>;
}

export interface ImplementationEvidence {
  content: string;
  digest: string;
}

export type ImplementationEvent =
  | {
      type: "assignment.start";
      runId: string;
      instanceId: string;
      attemptId: string;
      assignmentId?: string;
      planArtifactId: string;
      planDigest: string;
      assignment: PlannedAssignment;
      inputs: string[];
      inputArtifacts: ArtifactInput[];
      criteria: ImplementationCriterion[];
      verification: string[];
      selection: ModelSelection | null;
      model: string | null;
      baseCommit: string;
      attemptTimeMs: number;
      attemptCostMicros: number;
      globalBudget: RemainingBudget;
    }
  | {
      type: "attempt.finish";
      result: FinishAttempt;
      artifactId: string;
      evidence?: ImplementationEvidence;
    }
  | { type: "session.recover" };

type ImplementationResultByEvent = {
  "assignment.start": ImplementationAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "session.recover": undefined;
};

export interface ImplementationTransition<Result> {
  state: ImplementationState;
  facts: ImplementationFact[];
  result: Result;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const selection = (value: unknown): value is ModelSelection | null =>
  value === null ||
  (object(value) && [value.context, value.provider, value.model, value.thinking].every(text));
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
const artifactPath = (value: unknown): value is string =>
  typeof value === "string" && /^\.xper\/artifacts\/[a-z0-9-]+\.(json|log)$/.test(value);
const relativePath = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[a-zA-Z]:[\\/]/.test(value) &&
  !value.split(/[\\/]/).includes("..");
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

export function parseImplementationResult(
  content: string,
  expected: Pick<
    ImplementationState,
    "incrementId" | "baseCommit" | "planArtifactId" | "assignment"
  >,
): ImplementationResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("structured implementation result required");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["schemaVersion", "inputs", "output"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.inputs) ||
    !value.inputs.every(text) ||
    new Set(value.inputs).size !== value.inputs.length ||
    !object(value.output)
  )
    invalid("structured implementation result required");
  const inputs = [...expected.assignment.inputs].sort();
  if ([...value.inputs].sort().join("\n") !== inputs.join("\n"))
    invalid("implementation result input references do not match the sealed handoff");
  const output = value.output;
  if (
    !exactKeys(output, [
      "kind",
      "assignmentId",
      "incrementId",
      "baseCommit",
      "resultingCommit",
      "changedFiles",
      "tests",
      "criteria",
    ]) ||
    output.kind !== "implementation_result" ||
    output.assignmentId !== expected.assignment.id ||
    output.incrementId !== expected.incrementId ||
    output.baseCommit !== expected.baseCommit ||
    !sha(output.resultingCommit) ||
    output.resultingCommit === expected.baseCommit ||
    !Array.isArray(output.changedFiles) ||
    !output.changedFiles.length ||
    !output.changedFiles.every(relativePath) ||
    new Set(output.changedFiles).size !== output.changedFiles.length ||
    !Array.isArray(output.tests) ||
    !output.tests.length ||
    !output.tests.every(
      (test) =>
        object(test) &&
        exactKeys(test, ["command", "exitCode", "outputPath"]) &&
        text(test.command) &&
        integer(test.exitCode) &&
        artifactPath(test.outputPath),
    ) ||
    !Array.isArray(output.criteria)
  )
    invalid("implementation result does not satisfy its contract");
  const expectedCriteria = new Set(expected.assignment.criteria.map((criterion) => criterion.id));
  const actualCriteria = new Set<string>();
  for (const criterion of output.criteria) {
    if (
      !object(criterion) ||
      !exactKeys(criterion, ["criterionId", "evidence", "paths"]) ||
      !text(criterion.criterionId) ||
      !text(criterion.evidence) ||
      !Array.isArray(criterion.paths) ||
      !criterion.paths.every(relativePath) ||
      actualCriteria.has(criterion.criterionId)
    )
      invalid("implementation result needs unique evidence for every criterion");
    actualCriteria.add(criterion.criterionId);
  }
  if (
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((id) => !actualCriteria.has(id))
  )
    invalid("implementation result needs evidence for every selected criterion");
  return value as unknown as ImplementationResult;
}

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

function remainingLocal(state: ImplementationState, now: number): RemainingBudget {
  const attempts = Object.keys(state.attempts).length;
  return {
    attempts: Math.max(0, state.assignment.maxAttempts - attempts),
    timeMs: Math.max(0, state.assignment.maxTimeMs - Math.max(0, now - state.startedAt)),
    costMicros: Math.max(0, state.assignment.maxCostMicros - attempts * state.attemptCostMicros),
    concurrency: 1,
  };
}

export function transitionImplementation<E extends ImplementationEvent>(
  previous: ImplementationState | null,
  event: E,
  now: number,
): ImplementationTransition<ImplementationResultByEvent[E["type"]]> {
  const facts: ImplementationFact[] = [];
  const fact = (type: string, data: Record<string, unknown>) => facts.push({ type, data });
  let state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== implementationDefinition.id ||
      state.definition.version !== implementationDefinition.version)
  )
    invalid("unsupported implementation definition");
  const finish = (
    result: ImplementationResultByEvent[ImplementationEvent["type"]],
  ): ImplementationTransition<ImplementationResultByEvent[E["type"]]> => {
    if (!state) invalid("start an implementation flow first");
    if (facts.length) {
      state.revision++;
      fact("workflow.position", { ...implementationPosition(state) });
    }
    return {
      state,
      facts,
      result: structuredClone(result) as ImplementationResultByEvent[E["type"]],
    };
  };
  if (event.type === "assignment.start") {
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
    if (state.attempts[event.attemptId]) invalid("attempt ID already exists");
    const timeoutMs = Math.min(state.attemptTimeMs, local.timeMs, event.globalBudget.timeMs);
    const resultPath = `.xper/artifacts/implementation-result-${event.attemptId}.json`;
    const reservedCost = state.attemptCostMicros;
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
    return finish({
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
        attempts: Math.min(local.attempts - 1, event.globalBudget.attempts - 1),
        timeMs: timeoutMs,
        costMicros:
          event.globalBudget.costMicros === null
            ? Math.max(0, (local.costMicros ?? 0) - reservedCost)
            : Math.min(
                Math.max(0, (local.costMicros ?? 0) - reservedCost),
                Math.max(0, event.globalBudget.costMicros - reservedCost),
              ),
        concurrency: 1,
      },
    });
  }
  if (!state) invalid("start an implementation flow first");
  if (event.type === "attempt.finish") {
    const attempt = state.attempts[event.result.attemptId];
    if (!attempt) invalid("attempt is not registered");
    if (attempt.outcome !== null) {
      if (
        attempt.outcome !== event.result.outcome &&
        !(event.result.outcome === "succeeded" && attempt.outcome === "timed_out")
      )
        invalid("attempt already has a different outcome");
      return finish({
        attemptId: event.result.attemptId,
        outcome: attempt.outcome as FinishAttempt["outcome"],
        replayed: true,
      });
    }
    const late =
      event.result.outcome === "succeeded" && now - attempt.startedAt >= attempt.timeoutMs;
    const outcome = late ? "timed_out" : event.result.outcome;
    let report: ImplementationResult | undefined;
    if (event.evidence) {
      if (!("artifactPath" in event.result) || event.result.artifactPath !== attempt.artifactPath)
        invalid("artifact path does not match the implementation assignment");
      report = parseImplementationResult(event.evidence.content, state);
      if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
      state.artifacts[event.artifactId] = {
        artifact_id: event.artifactId,
        attemptId: event.result.attemptId,
        kind: "implementation_result",
        path: event.result.artifactPath,
        version: 1,
        digest: event.evidence.digest,
        inputs: [...state.assignment.inputs],
      };
      attempt.artifactId = event.artifactId;
      fact("artifact.registered", {
        artifactId: event.artifactId,
        attemptId: event.result.attemptId,
        kind: "implementation_result",
        path: event.result.artifactPath,
        digest: event.evidence.digest,
        inputs: state.assignment.inputs,
      });
    }
    if (outcome === "succeeded") {
      if (!report) invalid("implementation result evidence is required");
      if (report.output.tests.some((test) => test.exitCode !== 0))
        invalid("host-run implementation tests did not pass");
    }
    attempt.outcome = outcome;
    fact("attempt.finished", {
      attemptId: event.result.attemptId,
      assignmentId: state.assignment.id,
      outcome,
      durationMs: Math.max(0, now - attempt.startedAt),
    });
    if (outcome === "succeeded" && attempt.artifactId) {
      state.lifecycle = { status: "completed", artifactId: attempt.artifactId };
      fact("gate.passed", {
        phase: "implementation",
        incrementId: state.incrementId,
        artifactId: attempt.artifactId,
      });
      fact("workflow.transition", {
        transitionId: "implementation.accepted",
        from: "implement",
        to: "implemented",
        fromVisitId: state.instanceId,
        toVisitId: state.instanceId,
      });
      fact("workflow.completed", {
        incrementId: state.incrementId,
        artifactId: attempt.artifactId,
        outputKind: "implementation_result",
      });
    }
    return finish({
      attemptId: event.result.attemptId,
      outcome,
      artifactId: attempt.artifactId,
      ...(outcome === "succeeded" ? { workflowCompleted: true } : {}),
    });
  }
  for (const [attemptId, attempt] of Object.entries(state.attempts)) {
    if (attempt.outcome !== null) continue;
    attempt.outcome = "interrupted";
    fact("attempt.finished", {
      attemptId,
      assignmentId: state.assignment.id,
      outcome: "interrupted",
    });
  }
  return finish(undefined);
}

/** Validate implementation state restored from the adapter-owned checkpoint. */
export function decodeImplementationState(value: unknown): ImplementationState {
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.runId) ||
    !object(value.definition) ||
    value.definition.id !== implementationDefinition.id ||
    value.definition.version !== implementationDefinition.version ||
    !text(value.instanceId) ||
    !text(value.incrementId) ||
    !text(value.planArtifactId) ||
    !text(value.planDigest) ||
    !integer(value.startedAt) ||
    !sha(value.baseCommit) ||
    !object(value.assignment) ||
    !text(value.assignment.id) ||
    value.assignment.role !== "implementation.driver" ||
    value.assignment.incrementId !== value.incrementId ||
    !strings(value.assignment.dependencies) ||
    !text(value.assignment.workspace) ||
    !strings(value.assignment.resources) ||
    !integer(value.assignment.maxAttempts) ||
    value.assignment.maxAttempts < 1 ||
    !integer(value.assignment.maxTimeMs) ||
    value.assignment.maxTimeMs < 1 ||
    !integer(value.assignment.maxCostMicros) ||
    !strings(value.assignment.inputs) ||
    !value.assignment.inputs.length ||
    !Array.isArray(value.assignment.criteria) ||
    !value.assignment.criteria.length ||
    !value.assignment.criteria.every(
      (criterion) =>
        object(criterion) &&
        text(criterion.id) &&
        text(criterion.behavior) &&
        text(criterion.example),
    ) ||
    !strings(value.assignment.verification) ||
    !value.assignment.verification.length ||
    !selection(value.assignment.selection) ||
    !(value.assignment.model === null || text(value.assignment.model)) ||
    (value.assignment.selection === null) === (value.assignment.model === null) ||
    !strings(value.assignment.attemptIds) ||
    new Set(value.assignment.attemptIds).size !== value.assignment.attemptIds.length ||
    !integer(value.attemptTimeMs) ||
    value.attemptTimeMs < 1 ||
    !integer(value.attemptCostMicros) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.lifecycle) ||
    !["active", "completed"].includes(String(value.lifecycle.status))
  )
    invalid("unsupported implementation checkpoint");
  const state = value as unknown as ImplementationState;
  const completedArtifactId =
    state.lifecycle.status === "completed" ? state.lifecycle.artifactId : null;
  if (
    new Set(state.assignment.inputs).size !== state.assignment.inputs.length ||
    new Set(state.assignment.criteria.map((criterion) => criterion.id)).size !==
      state.assignment.criteria.length ||
    Object.keys(state.attempts).length !== state.assignment.attemptIds.length ||
    !state.assignment.attemptIds.every((id) => Object.hasOwn(state.attempts, id)) ||
    !Object.entries(state.attempts).every(
      ([attemptId, attempt]) =>
        text(attemptId) &&
        integer(attempt.startedAt) &&
        integer(attempt.timeoutMs) &&
        attempt.timeoutMs > 0 &&
        (attempt.outcome === null ||
          ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
            attempt.outcome,
          )) &&
        artifactPath(attempt.artifactPath) &&
        selection(attempt.selection) &&
        JSON.stringify(attempt.selection) === JSON.stringify(state.assignment.selection) &&
        attempt.model === state.assignment.model &&
        (attempt.artifactId === null || Object.hasOwn(state.artifacts, attempt.artifactId)) &&
        state.assignment.attemptIds.includes(attemptId),
    ) ||
    !Object.entries(state.artifacts).every(
      ([artifactId, artifact]) =>
        artifact.artifact_id === artifactId &&
        Object.hasOwn(state.attempts, artifact.attemptId) &&
        state.attempts[artifact.attemptId]?.artifactId === artifactId &&
        artifact.kind === "implementation_result" &&
        artifact.version === 1 &&
        artifactPath(artifact.path) &&
        text(artifact.digest) &&
        JSON.stringify(artifact.inputs) === JSON.stringify(state.assignment.inputs),
    ) ||
    (completedArtifactId === null &&
      Object.values(state.attempts).some((attempt) => attempt.outcome === "succeeded")) ||
    (completedArtifactId !== null &&
      (!Object.hasOwn(state.artifacts, completedArtifactId) ||
        !Object.values(state.attempts).some(
          (attempt) =>
            attempt.outcome === "succeeded" && attempt.artifactId === completedArtifactId,
        )))
  )
    invalid("invalid implementation checkpoint references");
  return structuredClone(state);
}
