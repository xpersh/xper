import type {
  AttemptOutcome,
  JudgmentRecommendation,
  RunAdvanced,
  WorkflowClient,
} from "../workflow/types.js";
import type { ExecutionRequest, ExecutionResult } from "./execution.js";

export type Observation =
  | { type: "attempt.correlated"; attemptId: string }
  | { type: "recording.failed"; attemptId: string }
  | { type: "attempt.finished"; attemptId: string; outcome: AttemptOutcome };

export interface DelegationDependencies {
  workflow: Pick<
    WorkflowClient,
    "startAssignment" | "finishAttempt" | "advanceRun" | "recordUsage"
  >;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  saveBrief(cwd: string, attemptId: string, brief: string, artifactPath?: string): Promise<string>;
  observe?(event: Observation): void;
}

export interface DelegationRequest {
  task: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSeconds?: number;
  assignmentId?: string;
  model?: string;
}

export interface DelegationResult {
  judgment?: JudgmentRecommendation;
  attemptId: string;
  outcome: AttemptOutcome;
  phase: string;
  incrementId?: string;
  artifactId: string | null;
  artifactPath?: string;
  gate?: RunAdvanced;
  reason?: string;
}
