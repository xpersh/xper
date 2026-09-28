import type { ModelSelection, RoutingSnapshot, AvailableModel } from "../bridge/xper-client.js";
export type { ModelSelection, RoutingSnapshot, AvailableModel } from "../bridge/xper-client.js";

export type AttemptOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RunStarted {
  runId: string;
  phase: string | null;
  resumed: boolean;
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

/** Adapter-owned workflow projection, stored as an opaque checkpoint by Xper. */
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
  /** Generic recorded facts; workflow recovery uses only versioned Pi checkpoints. */
  timeline: unknown[];
  durability: "persistent" | "volatile";
  degradedReason?: string | null;
}

/** Workflow operations available to adapter actions, independent of the transport. */
export interface WorkflowClient {
  recordUsage?(attemptId: string, usage: ModelUsage): Promise<void>;
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

export class WorkflowValidationError extends Error {}

export interface ModelUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicros?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  provider?: string;
  model?: string;
  costSource?: "pi_estimate";
}
