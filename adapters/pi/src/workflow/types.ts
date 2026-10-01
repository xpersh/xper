import type { ModelSelection, RoutingSnapshot } from "../bridge/xper-client.js";
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

interface AssignmentStartedBase {
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

export interface KnowledgeAssignmentStarted extends AssignmentStartedBase {
  /** Omitted for compatibility with the original Knowledge-only response. */
  workflow?: "knowledge";
}

export interface ImplementationCriterion {
  id: string;
  behavior: string;
  example: string;
}

export interface ImplementationAssignmentStarted extends AssignmentStartedBase {
  workflow: "implementation";
  incrementId: string;
  baseCommit: string;
  criteria: ImplementationCriterion[];
  verification: string[];
  model?: string;
}

export interface VerificationAssignmentStarted extends AssignmentStartedBase {
  workflow: "verification";
  incrementId: string;
  implementationArtifactId: string;
  baseCommit: string;
  evaluatedCommit: string;
  implementationTestCommands: string[];
  criteria: ImplementationCriterion[];
  verification: string[];
  model?: string;
}

export interface JudgmentEvaluation {
  planArtifactId: string;
  incrementIds: string[];
  criterionIds: string[];
  artifacts: Array<ArtifactInput & { digest: string }>;
  logs: Array<{ path: string; digest: string }>;
  baseCommit: string;
  evaluatedCommit: string;
}
export interface JudgmentAssignmentStarted extends AssignmentStartedBase {
  workflow: "judgment";
  evaluation: JudgmentEvaluation;
  model?: string;
}
export interface JudgmentRecommendation {
  verdict: string;
  evaluatedCommit: string;
  applied: false;
}
export type AssignmentStarted =
  | KnowledgeAssignmentStarted
  | ImplementationAssignmentStarted
  | VerificationAssignmentStarted
  | JudgmentAssignmentStarted;
export type StartedAssignment = AssignmentStarted;

export type FinishAttempt = { attemptId: string } & (
  | { outcome: "succeeded"; artifactPath: string }
  | { outcome: "failed"; artifactPath?: string }
  | { outcome: Exclude<AttemptOutcome, "succeeded" | "failed"> }
);

export type AttemptFinished = { attemptId: string; outcome: AttemptOutcome } & (
  | { replayed: true }
  | { replayed?: false; artifactId: string | null; workflowCompleted?: boolean }
) & {
    handoffPhase?: "define" | "design";
    judgment?: JudgmentRecommendation;
  };

export type RunAdvanced = {
  ready?: boolean;
  humanArtifactId?: string;
  resumeRequired?: boolean;
} & (
  | { advanced: true; phase: string; resumed?: boolean }
  | { advanced: false; phase: string; reason: string }
);

/** Adapter-owned workflow projection, stored as an opaque checkpoint by Xper. */
export interface RunSummary {
  run_id: string;
  routing?: RoutingSnapshot | null;
  visits: Array<{ phase: string }>;
  attempts: Record<string, { outcome: AttemptOutcome | "interrupted" | null }>;
  artifacts: Record<string, unknown>;
  accepted?: Record<string, string>;
  human_input?: [string, string] | null;
}

/** Inspection data, independent of renderer and workflow-specific context. */
export interface WorkflowPosition {
  definitionId: string;
  definitionVersion: number;
  instanceId: string;
  nodeId: string;
  phase: string;
  visitId: string;
  status: "active" | "awaiting_approval" | "completed";
  activeAttemptIds: string[];
  artifactId?: string;
}

export interface RunStatus {
  closure?: RunClosure;
  judgment?: WorkflowPosition & {
    assignmentId: string;
    evaluatedCommit: string;
    verdict?: string;
    artifactPath?: string;
    applied: boolean;
  };
  workflow?: WorkflowPosition;
  implementations?: Record<string, WorkflowPosition>;
  verifications?: Record<string, WorkflowPosition>;
  run: RunSummary | null;
  /** Locally observed facts; complete shared history is queried through XperClient. */
  timeline: unknown[];
  durability: "persistent" | "volatile";
  degradedReason?: string | null;
  reconciliation?: {
    status: "revisiting" | "awaiting_resume" | "resumed";
    reason: "ambiguous_criteria" | "infeasible_design";
    verificationArtifactId: string;
    previousPlanArtifactId: string;
    revisedPlanArtifactId?: string;
    resumeCommit?: string;
  };
}

export interface DeliveryResumed {
  planArtifactId: string;
  checkoutRevision: string;
  replayed: boolean;
}

export interface RunClosure {
  reportId: string;
  reportDigest: string;
  planArtifactId: string;
  evaluatedCommit: string;
  verdict: "ACCEPT" | "REJECT";
  status: "accepted" | "rejected";
  incrementIds: string[];
  closedAt: number;
  summary: ArtifactInput & { digest: string };
}
export interface JudgmentApplied extends RunClosure {
  runId: string;
  replayed: boolean;
}

/** Workflow operations available to adapter actions, independent of the transport. */
export interface WorkflowClient {
  recordUsage?(attemptId: string, usage: ModelUsage): Promise<void>;
  startRun(objective: string, policy?: WorkflowPolicy): Promise<RunStarted>;
  inspectProfile(): Promise<RoutingSnapshot | null>;
  startAssignment(assignmentId?: string, fallbackModel?: string): Promise<StartedAssignment>;
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished>;
  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced>;
  resumeDelivery(revision: string): Promise<DeliveryResumed>;
  applyJudgment(reportId: string, revision: string): Promise<JudgmentApplied>;
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
