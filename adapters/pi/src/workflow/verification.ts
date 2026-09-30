import { object } from "../bridge/xper-client.js";
import type { PlannedAssignment } from "./contracts.js";
import { verificationDefinition } from "./definition.js";
import type {
  ArtifactInput,
  AttemptFinished,
  FinishAttempt,
  ImplementationCriterion,
  ModelSelection,
  RemainingBudget,
  VerificationAssignmentStarted,
  WorkflowPosition,
} from "./types.js";
import { WorkflowValidationError } from "./types.js";

export interface VerificationTestResult {
  command: string;
  exitCode: number;
  outputPath: string;
}

export interface VerificationFinding {
  outcome: "passed" | "failed";
  evidence: string;
  paths: string[];
}

export type KnowledgeFeedbackReason = "ambiguous_criteria" | "infeasible_design";

export interface VerificationRejection {
  cause: string;
  evidence: string;
  paths: string[];
  /** Optional for backwards-compatible verification-v1 artifacts. */
  knowledgeFeedback?: { reason: KnowledgeFeedbackReason } | null;
}

export interface VerificationResult {
  schemaVersion: 1;
  inputs: string[];
  output: {
    kind: "verification_result";
    assignmentId: string;
    incrementId: string;
    implementationArtifactId: string;
    baseCommit: string;
    evaluatedCommit: string;
    verdict: "verified" | "rejected";
    tests: VerificationTestResult[];
    criteria: Array<VerificationFinding & { criterionId: string }>;
    review: {
      regressions: VerificationFinding;
      scope: VerificationFinding;
      simplicity: VerificationFinding;
    };
    rejection: null | VerificationRejection;
  };
}

export interface VerificationAttempt {
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
  model: string | null;
}

export interface VerificationArtifact {
  artifact_id: string;
  attemptId: string;
  kind: "verification_result";
  path: string;
  version: 1;
  digest: string;
  inputs: string[];
  verdict: "verified" | "rejected";
  evaluatedCommit: string;
  knowledgeFeedbackReason?: KnowledgeFeedbackReason;
}

export interface VerificationState {
  version: 1;
  revision: number;
  runId: string;
  definition: { id: string; version: number };
  instanceId: string;
  incrementId: string;
  planArtifactId: string;
  planDigest: string;
  startedAt: number;
  implementation: {
    instanceId: string;
    artifactId: string;
    digest: string;
    baseCommit: string;
    evaluatedCommit: string;
    testCommands: string[];
  };
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
  attempts: Record<string, VerificationAttempt>;
  artifacts: Record<string, VerificationArtifact>;
  lifecycle:
    | { status: "active" }
    | { status: "completed"; artifactId: string; verdict: "verified" | "rejected" };
}

export interface VerificationEvidence {
  content: string;
  digest: string;
}

export interface VerificationFact {
  type: string;
  data: Record<string, unknown>;
}

export type VerificationEvent =
  | {
      type: "assignment.start";
      runId: string;
      instanceId: string;
      attemptId: string;
      assignmentId?: string;
      planArtifactId: string;
      planDigest: string;
      implementation: VerificationState["implementation"];
      assignment: PlannedAssignment;
      inputs: string[];
      inputArtifacts: ArtifactInput[];
      criteria: ImplementationCriterion[];
      verification: string[];
      selection: ModelSelection | null;
      model: string | null;
      attemptTimeMs: number;
      attemptCostMicros: number;
      assignmentBudget: RemainingBudget;
      globalBudget: RemainingBudget;
    }
  | {
      type: "attempt.finish";
      result: FinishAttempt;
      artifactId: string;
      evidence?: VerificationEvidence;
    }
  | { type: "session.recover" };

type Results = {
  "assignment.start": VerificationAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "session.recover": undefined;
};

export interface VerificationTransition<Result> {
  state: VerificationState;
  facts: VerificationFact[];
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
const relativePath = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.split(/[\\/]/).includes("..");
const artifactPath = (value: unknown): value is string =>
  typeof value === "string" && /^\.xper\/artifacts\/[a-z0-9-]+\.(json|log)$/.test(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const knowledgeFeedbackReason = (value: unknown): value is KnowledgeFeedbackReason =>
  value === "ambiguous_criteria" || value === "infeasible_design";
function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

function parseFinding(value: unknown): VerificationFinding {
  if (
    !object(value) ||
    !exactKeys(value, ["outcome", "evidence", "paths"]) ||
    !["passed", "failed"].includes(String(value.outcome)) ||
    !text(value.evidence) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(relativePath)
  )
    invalid("verification result has invalid review evidence");
  return value as unknown as VerificationFinding;
}

export function parseVerificationResult(
  content: string,
  expected: VerificationState,
): VerificationResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("structured verification result required");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["schemaVersion", "inputs", "output"]) ||
    value.schemaVersion !== 1 ||
    !strings(value.inputs) ||
    new Set(value.inputs).size !== value.inputs.length ||
    [...value.inputs].sort().join("\n") !== [...expected.assignment.inputs].sort().join("\n") ||
    !object(value.output)
  )
    invalid("structured verification result required");
  const output = value.output;
  if (
    !exactKeys(output, [
      "kind",
      "assignmentId",
      "incrementId",
      "implementationArtifactId",
      "baseCommit",
      "evaluatedCommit",
      "verdict",
      "tests",
      "criteria",
      "review",
      "rejection",
    ]) ||
    output.kind !== "verification_result" ||
    output.assignmentId !== expected.assignment.id ||
    output.incrementId !== expected.incrementId ||
    output.implementationArtifactId !== expected.implementation.artifactId ||
    output.baseCommit !== expected.implementation.baseCommit ||
    output.evaluatedCommit !== expected.implementation.evaluatedCommit ||
    !["verified", "rejected"].includes(String(output.verdict)) ||
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
    !Array.isArray(output.criteria) ||
    !object(output.review) ||
    !exactKeys(output.review, ["regressions", "scope", "simplicity"])
  )
    invalid("verification result does not satisfy its contract");
  const expectedCriteria = new Set(expected.assignment.criteria.map((criterion) => criterion.id));
  const actualCriteria = new Set<string>();
  const criteria = output.criteria.map((criterion) => {
    if (
      !object(criterion) ||
      !exactKeys(criterion, ["criterionId", "outcome", "evidence", "paths"]) ||
      !text(criterion.criterionId) ||
      actualCriteria.has(criterion.criterionId)
    )
      invalid("verification result needs unique evidence for every criterion");
    actualCriteria.add(criterion.criterionId);
    return {
      criterionId: criterion.criterionId,
      ...parseFinding({
        outcome: criterion.outcome,
        evidence: criterion.evidence,
        paths: criterion.paths,
      }),
    };
  });
  if (
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((id) => !actualCriteria.has(id))
  )
    invalid("verification result needs evidence for every selected criterion");
  const review = {
    regressions: parseFinding(output.review.regressions),
    scope: parseFinding(output.review.scope),
    simplicity: parseFinding(output.review.simplicity),
  };
  const failures = [
    ...criteria.map((criterion) => criterion.outcome),
    ...Object.values(review).map((finding) => finding.outcome),
    ...output.tests.map((test) => (test.exitCode === 0 ? "passed" : "failed")),
  ].some((outcome) => outcome === "failed");
  const rejection = output.rejection;
  const validRejection =
    rejection === null ||
    (object(rejection) &&
      (exactKeys(rejection, ["cause", "evidence", "paths"]) ||
        exactKeys(rejection, ["cause", "evidence", "paths", "knowledgeFeedback"])) &&
      text(rejection.cause) &&
      text(rejection.evidence) &&
      Array.isArray(rejection.paths) &&
      rejection.paths.every(relativePath) &&
      (rejection.knowledgeFeedback === undefined ||
        rejection.knowledgeFeedback === null ||
        (object(rejection.knowledgeFeedback) &&
          exactKeys(rejection.knowledgeFeedback, ["reason"]) &&
          knowledgeFeedbackReason(rejection.knowledgeFeedback.reason))));
  if (
    !validRejection ||
    (output.verdict === "verified" && (failures || rejection !== null)) ||
    (output.verdict === "rejected" && (!failures || rejection === null))
  )
    invalid("verification verdict is inconsistent with its evidence");
  return value as unknown as VerificationResult;
}

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

function remainingLocal(state: VerificationState, now: number): RemainingBudget {
  const attempts = Object.keys(state.attempts).length;
  return {
    attempts: Math.max(0, state.assignment.maxAttempts - attempts),
    timeMs: Math.max(0, state.assignment.maxTimeMs - Math.max(0, now - state.startedAt)),
    costMicros: Math.max(0, state.assignment.maxCostMicros - attempts * state.attemptCostMicros),
    concurrency: 1,
  };
}

function requireBudget(
  budget: RemainingBudget,
  cost: number,
  label: "verification" | "assignment" | "run",
): void {
  if (!budget.attempts) invalid(`${label} attempt budget exhausted`);
  if (!budget.timeMs) invalid(`${label} time budget exhausted`);
  if (budget.costMicros !== null && budget.costMicros < cost)
    invalid(`${label} cost budget exhausted`);
}

export function transitionVerification<E extends VerificationEvent>(
  previous: VerificationState | null,
  event: E,
  now: number,
): VerificationTransition<Results[E["type"]]> {
  const facts: VerificationFact[] = [];
  const fact = (type: string, data: Record<string, unknown>) => facts.push({ type, data });
  let state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== verificationDefinition.id ||
      state.definition.version !== verificationDefinition.version)
  )
    invalid("unsupported verification definition");
  const finish = (result: Results[VerificationEvent["type"]]) => {
    if (!state) invalid("start a verification flow first");
    if (facts.length) {
      state.revision++;
      fact("workflow.position", { ...verificationPosition(state) });
    }
    return {
      state,
      facts,
      result: structuredClone(result) as Results[E["type"]],
    };
  };
  if (event.type === "assignment.start") {
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
    return finish({
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
    });
  }
  if (!state) invalid("start a verification flow first");
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
    let report: VerificationResult | undefined;
    if (event.evidence) {
      if (!("artifactPath" in event.result) || event.result.artifactPath !== attempt.artifactPath)
        invalid("artifact path does not match the verification assignment");
      report = parseVerificationResult(event.evidence.content, state);
      if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
      state.artifacts[event.artifactId] = {
        artifact_id: event.artifactId,
        attemptId: event.result.attemptId,
        kind: "verification_result",
        path: event.result.artifactPath,
        version: 1,
        digest: event.evidence.digest,
        inputs: [...state.assignment.inputs],
        verdict: report.output.verdict,
        evaluatedCommit: report.output.evaluatedCommit,
        ...(report.output.rejection?.knowledgeFeedback
          ? { knowledgeFeedbackReason: report.output.rejection.knowledgeFeedback.reason }
          : {}),
      };
      attempt.artifactId = event.artifactId;
      fact("artifact.registered", {
        artifactId: event.artifactId,
        attemptId: event.result.attemptId,
        kind: "verification_result",
        path: event.result.artifactPath,
        digest: event.evidence.digest,
        inputs: state.assignment.inputs,
      });
    }
    if (outcome === "succeeded" && !report) invalid("verification result evidence is required");
    attempt.outcome = outcome;
    fact("attempt.finished", {
      attemptId: event.result.attemptId,
      assignmentId: state.assignment.id,
      outcome,
      durationMs: Math.max(0, now - attempt.startedAt),
    });
    if (outcome === "succeeded" && attempt.artifactId && report) {
      const verdict = report.output.verdict;
      state.lifecycle = { status: "completed", artifactId: attempt.artifactId, verdict };
      fact(verdict === "verified" ? "gate.passed" : "gate.rejected", {
        phase: "verification",
        incrementId: state.incrementId,
        artifactId: attempt.artifactId,
        implementationArtifactId: state.implementation.artifactId,
        evaluatedCommit: state.implementation.evaluatedCommit,
        ...(report.output.rejection ? { rejection: report.output.rejection } : {}),
      });
      if (verdict === "rejected") {
        fact("artifact.invalidated", {
          artifactId: state.implementation.artifactId,
          reasonArtifactId: attempt.artifactId,
        });
        const feedback = report.output.rejection?.knowledgeFeedback;
        if (feedback) {
          fact("knowledge.feedback_requested", {
            sourceAttemptId: event.result.attemptId,
            incrementId: state.incrementId,
            planArtifactId: state.planArtifactId,
            planDigest: state.planDigest,
            verificationArtifactId: attempt.artifactId,
            reason: feedback.reason,
            evidence: report.output.rejection?.evidence,
            paths: report.output.rejection?.paths,
          });
        } else {
          fact("implementation.rework_requested", {
            incrementId: state.incrementId,
            implementationArtifactId: state.implementation.artifactId,
            verificationArtifactId: attempt.artifactId,
            cause: report.output.rejection?.cause,
            evidence: report.output.rejection?.evidence,
          });
        }
      }
      fact("workflow.transition", {
        transitionId: verdict === "verified" ? "verification.accepted" : "verification.rejected",
        from: "verify",
        to: verdict,
        fromVisitId: state.instanceId,
        toVisitId: state.instanceId,
      });
      fact("workflow.completed", {
        incrementId: state.incrementId,
        artifactId: attempt.artifactId,
        outputKind: "verification_result",
        verdict,
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

/** Validate verification state restored from the adapter-owned checkpoint. */
export function decodeVerificationState(value: unknown): VerificationState {
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.runId) ||
    !object(value.definition) ||
    value.definition.id !== verificationDefinition.id ||
    value.definition.version !== verificationDefinition.version ||
    !text(value.instanceId) ||
    !text(value.incrementId) ||
    !text(value.planArtifactId) ||
    !text(value.planDigest) ||
    !integer(value.startedAt) ||
    !object(value.implementation) ||
    !text(value.implementation.instanceId) ||
    !text(value.implementation.artifactId) ||
    !text(value.implementation.digest) ||
    !sha(value.implementation.baseCommit) ||
    !sha(value.implementation.evaluatedCommit) ||
    value.implementation.baseCommit === value.implementation.evaluatedCommit ||
    !strings(value.implementation.testCommands) ||
    !value.implementation.testCommands.length ||
    !object(value.assignment) ||
    !text(value.assignment.id) ||
    value.assignment.role !== "verify.verifier" ||
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
    !integer(value.attemptTimeMs) ||
    value.attemptTimeMs < 1 ||
    !integer(value.attemptCostMicros) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.lifecycle) ||
    !["active", "completed"].includes(String(value.lifecycle.status))
  )
    invalid("unsupported verification checkpoint");
  const state = value as unknown as VerificationState;
  const completedArtifactId =
    state.lifecycle.status === "completed" ? state.lifecycle.artifactId : null;
  const completedVerdict = state.lifecycle.status === "completed" ? state.lifecycle.verdict : null;
  if (
    new Set(state.assignment.inputs).size !== state.assignment.inputs.length ||
    new Set(state.assignment.criteria.map((criterion) => criterion.id)).size !==
      state.assignment.criteria.length ||
    new Set(state.assignment.attemptIds).size !== state.assignment.attemptIds.length ||
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
        (attempt.artifactId === null || Object.hasOwn(state.artifacts, attempt.artifactId)),
    ) ||
    !Object.entries(state.artifacts).every(
      ([artifactId, artifact]) =>
        artifact.artifact_id === artifactId &&
        Object.hasOwn(state.attempts, artifact.attemptId) &&
        state.attempts[artifact.attemptId]?.artifactId === artifactId &&
        artifact.kind === "verification_result" &&
        artifact.version === 1 &&
        artifactPath(artifact.path) &&
        text(artifact.digest) &&
        JSON.stringify(artifact.inputs) === JSON.stringify(state.assignment.inputs) &&
        ["verified", "rejected"].includes(artifact.verdict) &&
        artifact.evaluatedCommit === state.implementation.evaluatedCommit &&
        (artifact.knowledgeFeedbackReason === undefined ||
          (artifact.verdict === "rejected" &&
            knowledgeFeedbackReason(artifact.knowledgeFeedbackReason))),
    ) ||
    (completedArtifactId === null &&
      Object.values(state.attempts).some((attempt) => attempt.outcome === "succeeded")) ||
    (completedArtifactId !== null &&
      (!Object.hasOwn(state.artifacts, completedArtifactId) ||
        state.artifacts[completedArtifactId]?.verdict !== completedVerdict ||
        !Object.values(state.attempts).some(
          (attempt) =>
            attempt.outcome === "succeeded" && attempt.artifactId === completedArtifactId,
        )))
  )
    invalid("invalid verification checkpoint references");
  return structuredClone(state);
}
