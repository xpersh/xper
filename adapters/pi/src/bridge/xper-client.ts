import { ProtocolFailure, errorCode } from "./protocol.js";

export type AttemptOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RunStarted {
  runId: string;
  phase: string | null;
  resumed: boolean;
}

export interface ModelSelection {
  context: string;
  provider: string;
  model: string;
  thinking: string;
}

export interface RoutingSnapshot {
  profile: string;
  context: string;
  routes: Record<string, ModelSelection[]>;
}

export interface AvailableModel {
  provider: string;
  model: string;
  reasoning: boolean;
}

export interface ArtifactInput {
  artifact_id: string;
  kind: string;
  path: string;
  version: number;
}

export interface WorkflowPolicy {
  maxAttempts?: number;
  maxTimeMs?: number;
  attemptTimeMs?: number;
  maxConcurrency?: number;
  maxCostMicros?: number | null;
  attemptCostMicros?: number;
  humanGates?: string[];
}

export interface RemainingBudget {
  attempts: number;
  timeMs: number;
  costMicros: number | null;
  concurrency: number;
}

export interface AssignmentStarted {
  runId: string;
  assignmentId: string;
  attemptId: string;
  role: string;
  selection: ModelSelection | null;
  phase?: string;
  artifactKind?: string;
  artifactPath?: string;
  inputArtifacts?: ArtifactInput[];
  timeoutMs?: number;
  budget?: RemainingBudget;
}

export type FinishAttempt = { attemptId: string } & (
  | { outcome: "succeeded"; artifactPath: string }
  | { outcome: Exclude<AttemptOutcome, "succeeded"> }
);

export type AttemptFinished = { attemptId: string; outcome: AttemptOutcome } & (
  | { replayed: true }
  | { replayed?: false; artifactId: string | null }
);

export type RunAdvanced = { ready?: boolean; humanArtifactId?: string } & (
  | { advanced: true; phase: string; resumed?: boolean }
  | { advanced: false; phase: string; reason: string }
);

/** The projection fields used by this adapter; other core fields remain opaque. */
export interface RunSummary {
  run_id: string;
  visits: Array<{ phase: string }>;
  attempts: Record<string, { outcome: AttemptOutcome | "interrupted" | null }>;
  artifacts: Record<string, unknown>;
  accepted?: Record<string, string>;
  human_input?: [string, string] | null;
}

export interface RunStatus {
  run: RunSummary | null;
  /** Events are passed through, never interpreted as workflow rules here. */
  timeline: unknown[];
  durability: "persistent" | "volatile";
  degradedReason?: string | null;
}

/** Workflow operations available to adapter actions, independent of the transport. */
export interface WorkflowClient {
  startRun(
    objective: string,
    models?: AvailableModel[],
    policy?: WorkflowPolicy,
  ): Promise<RunStarted>;
  inspectProfile(): Promise<RoutingSnapshot | null>;
  startAssignment(assignmentId?: string): Promise<AssignmentStarted>;
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished>;
  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced>;
  getRunStatus(): Promise<RunStatus>;
}

export interface RpcRequester {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function attemptOutcome(value: unknown): value is AttemptOutcome {
  return (
    value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed_out"
  );
}

function modelSelection(value: unknown): value is ModelSelection {
  return (
    object(value) &&
    text(value.context) &&
    text(value.provider) &&
    text(value.model) &&
    text(value.thinking)
  );
}

function routingSnapshot(value: unknown): value is RoutingSnapshot {
  return (
    object(value) &&
    text(value.profile) &&
    text(value.context) &&
    object(value.routes) &&
    Object.values(value.routes).every(
      (items) => Array.isArray(items) && items.length > 0 && items.every(modelSelection),
    )
  );
}

function runStarted(value: unknown): value is RunStarted {
  return (
    object(value) &&
    text(value.runId) &&
    (value.phase === null || text(value.phase)) &&
    typeof value.resumed === "boolean"
  );
}

function assignmentStarted(value: unknown): value is AssignmentStarted {
  return (
    object(value) &&
    text(value.runId) &&
    text(value.assignmentId) &&
    text(value.attemptId) &&
    text(value.role) &&
    (value.selection === null || modelSelection(value.selection)) &&
    (value.budget === undefined ||
      (object(value.budget) &&
        Number.isSafeInteger(value.budget.attempts) &&
        Number(value.budget.attempts) >= 0 &&
        Number.isSafeInteger(value.budget.timeMs) &&
        Number(value.budget.timeMs) > 0 &&
        Number.isSafeInteger(value.budget.concurrency) &&
        Number(value.budget.concurrency) > 0 &&
        (value.budget.costMicros === null ||
          (Number.isSafeInteger(value.budget.costMicros) &&
            Number(value.budget.costMicros) >= 0)))) &&
    (value.phase === undefined || text(value.phase)) &&
    (value.artifactKind === undefined || text(value.artifactKind)) &&
    (value.artifactPath === undefined || text(value.artifactPath)) &&
    (value.timeoutMs === undefined ||
      (Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) > 0)) &&
    (value.inputArtifacts === undefined ||
      (Array.isArray(value.inputArtifacts) &&
        value.inputArtifacts.every(
          (artifact: unknown) =>
            object(artifact) &&
            text(artifact.artifact_id) &&
            text(artifact.kind) &&
            text(artifact.path) &&
            Number.isSafeInteger(artifact.version) &&
            Number(artifact.version) > 0,
        )))
  );
}

function attemptFinished(value: unknown): value is AttemptFinished {
  if (!object(value) || !text(value.attemptId) || !attemptOutcome(value.outcome)) return false;
  if (value.replayed === true) return true;
  return (
    (value.replayed === undefined || value.replayed === false) &&
    (value.outcome === "succeeded" ? text(value.artifactId) : value.artifactId === null)
  );
}

function runAdvanced(value: unknown): value is RunAdvanced {
  if (
    !object(value) ||
    !text(value.phase) ||
    (value.ready !== undefined && typeof value.ready !== "boolean") ||
    (value.humanArtifactId !== undefined && !text(value.humanArtifactId))
  )
    return false;
  if (value.advanced === false) return text(value.reason);
  return (
    value.advanced === true && (value.resumed === undefined || typeof value.resumed === "boolean")
  );
}

function runSummary(value: unknown): value is RunSummary {
  return (
    object(value) &&
    text(value.run_id) &&
    Array.isArray(value.visits) &&
    value.visits.every((visit: unknown) => object(visit) && text(visit.phase)) &&
    object(value.attempts) &&
    Object.values(value.attempts).every(
      (attempt) =>
        object(attempt) &&
        (attempt.outcome === null ||
          attempt.outcome === "interrupted" ||
          attemptOutcome(attempt.outcome)),
    ) &&
    object(value.artifacts) &&
    (value.accepted === undefined ||
      (object(value.accepted) && Object.values(value.accepted).every(text))) &&
    (value.human_input === undefined ||
      value.human_input === null ||
      (Array.isArray(value.human_input) &&
        value.human_input.length === 2 &&
        value.human_input.every(text)))
  );
}

function runStatus(value: unknown): value is RunStatus {
  return (
    object(value) &&
    (value.run === null || runSummary(value.run)) &&
    Array.isArray(value.timeline) &&
    (value.durability === "persistent" || value.durability === "volatile") &&
    (value.degradedReason === undefined ||
      value.degradedReason === null ||
      typeof value.degradedReason === "string")
  );
}

function invalidResult(method: string): ProtocolFailure {
  // Never include response bodies: they can contain user data.
  return new ProtocolFailure(errorCode.invalidRequest, `invalid ${method} result`);
}

/** Typed workflow facade. Validates v1 response fields and preserves RPC failures. */
export class XperClient implements WorkflowClient {
  constructor(private readonly rpc: RpcRequester) {}

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<T> {
    const result = await this.rpc.request(method, params);
    if (!valid(result)) throw invalidResult(method);
    return result;
  }

  startRun(
    objective: string,
    models?: AvailableModel[],
    policy?: WorkflowPolicy,
  ): Promise<RunStarted> {
    return this.call(
      "run.start",
      { objective, ...(models ? { models } : {}), ...(policy ? { policy } : {}) },
      runStarted,
    );
  }

  async inspectProfile(): Promise<RoutingSnapshot | null> {
    const value = await this.call(
      "profile.inspect",
      {},
      (result): result is { routing: RoutingSnapshot | null } =>
        object(result) && (result.routing === null || routingSnapshot(result.routing)),
    );
    return value.routing;
  }

  async startAssignment(assignmentId?: string): Promise<AssignmentStarted> {
    const result = await this.call(
      "assignment.start",
      assignmentId ? { assignmentId } : {},
      assignmentStarted,
    );
    if (assignmentId && result.assignmentId !== assignmentId)
      throw invalidResult("assignment.start");
    return result;
  }

  async finishAttempt(completion: FinishAttempt): Promise<AttemptFinished> {
    const result = await this.call("attempt.finish", { ...completion }, attemptFinished);
    if (
      result.attemptId !== completion.attemptId ||
      (result.outcome !== completion.outcome &&
        !(completion.outcome === "succeeded" && result.outcome === "timed_out"))
    ) {
      throw invalidResult("attempt.finish");
    }
    return result;
  }

  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced> {
    return this.call("run.advance", approvedArtifactId ? { approvedArtifactId } : {}, runAdvanced);
  }

  getRunStatus(): Promise<RunStatus> {
    return this.call("run.status", {}, runStatus);
  }
}
