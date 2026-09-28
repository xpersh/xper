import { WorkflowValidationError } from "../workflow/types.js";
import type {
  AttemptOutcome,
  FinishAttempt,
  ModelSelection,
  WorkflowClient,
  ArtifactInput,
  RemainingBudget,
  RunAdvanced,
  ModelUsage,
} from "../workflow/types.js";

export type KnowledgeExecutionResult = { usage?: ModelUsage[] } & (
  | { outcome: "succeeded"; brief: string }
  | { outcome: Exclude<AttemptOutcome, "succeeded"> }
);

export interface KnowledgeExecution {
  task: string;
  role: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  model?: string;
  selection?: ModelSelection;
  inputArtifacts?: ArtifactInput[];
  artifactKind?: string;
  budget?: RemainingBudget;
}

type Observation =
  | { type: "attempt.correlated"; attemptId: string }
  | { type: "recording.failed"; attemptId: string }
  | { type: "attempt.finished"; attemptId: string; outcome: AttemptOutcome };

export interface KnowledgeDependencies {
  workflow: Pick<
    WorkflowClient,
    "startAssignment" | "finishAttempt" | "advanceRun" | "recordUsage"
  >;
  execute(request: KnowledgeExecution): Promise<KnowledgeExecutionResult>;
  saveBrief(cwd: string, attemptId: string, brief: string, artifactPath?: string): Promise<string>;
  observe?(event: Observation): void;
}

export interface DelegateKnowledgeRequest {
  task: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSeconds?: number;
  assignmentId?: string;
  model?: string;
}

export interface DelegateKnowledgeResult {
  attemptId: string;
  outcome: AttemptOutcome;
  phase: string;
  artifactId: string | null;
  artifactPath?: string;
  gate?: RunAdvanced;
  reason?: string;
}

/** Coordinate execution using the Pi-owned workflow policy. */
export async function delegateKnowledge(
  request: DelegateKnowledgeRequest,
  dependencies: KnowledgeDependencies,
): Promise<DelegateKnowledgeResult> {
  if (!request.task?.trim()) throw new Error("Knowledge task is required");
  const timeoutSeconds = request.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new Error("timeoutSeconds must be between 1 and 600");
  }
  const { workflow } = dependencies;
  const started = await workflow.startAssignment(request.assignmentId);
  const { attemptId } = started;
  dependencies.observe?.({ type: "attempt.correlated", attemptId });

  let completion: FinishAttempt = { attemptId, outcome: "failed" };
  try {
    const result = await dependencies.execute({
      task: request.task,
      cwd: request.cwd,
      role: started.role,
      signal: request.signal,
      timeoutMs: Math.min(timeoutSeconds * 1_000, started.timeoutMs ?? Infinity),
      ...(started.inputArtifacts ? { inputArtifacts: started.inputArtifacts } : {}),
      ...(started.artifactKind ? { artifactKind: started.artifactKind } : {}),
      ...(started.budget ? { budget: started.budget } : {}),
      ...(started.selection
        ? { selection: started.selection }
        : request.model
          ? { model: request.model }
          : {}),
    });
    for (const usage of result.usage ?? []) {
      try {
        await workflow.recordUsage?.(attemptId, usage);
      } catch {
        dependencies.observe?.({ type: "recording.failed", attemptId });
      }
    }
    if (result.outcome === "succeeded") {
      if (!result.brief.trim()) throw new Error("Phase artifact is empty");
      const artifactPath = await dependencies.saveBrief(
        request.cwd,
        attemptId,
        result.brief,
        started.artifactPath,
      );
      completion = { attemptId, outcome: "succeeded", artifactPath };
    } else {
      completion = { attemptId, outcome: result.outcome };
    }
  } catch {
    completion = { attemptId, outcome: request.signal.aborted ? "cancelled" : "failed" };
  }

  let reason: string | undefined;
  const settled = await workflow.finishAttempt(completion).catch(async (error: unknown) => {
    // The Pi controller validates before settling. Malformed output becomes a
    // failed attempt; recorder availability does not affect that decision.
    if (completion.outcome !== "succeeded" || !(error instanceof WorkflowValidationError))
      throw error;
    reason = error.message;
    return workflow.finishAttempt({ attemptId, outcome: "failed" });
  });
  dependencies.observe?.({ type: "attempt.finished", attemptId, outcome: settled.outcome });
  const gate = settled.outcome === "succeeded" ? await workflow.advanceRun() : undefined;
  const phase = gate?.phase ?? started.phase ?? "discovery";
  return {
    attemptId,
    outcome: settled.outcome,
    phase,
    ...(gate ? { gate } : {}),
    ...(reason ? { reason } : {}),
    artifactId: settled.replayed ? null : settled.artifactId,
    ...(settled.outcome === "succeeded" && completion.outcome === "succeeded"
      ? { artifactPath: completion.artifactPath }
      : {}),
  };
}
