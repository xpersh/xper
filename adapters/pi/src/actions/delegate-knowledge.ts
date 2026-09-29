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

export type KnowledgeExecutionResult = {
  outcome: AttemptOutcome;
  brief?: string | undefined;
  reason?: string | undefined;
  usage?: ModelUsage[] | undefined;
};

export interface KnowledgeExecution {
  attemptId?: string;
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
  workflow?: "knowledge" | "implementation";
  assignmentId?: string;
  incrementId?: string;
  baseCommit?: string;
  criteria?: Array<{ id: string; behavior: string; example: string }>;
  verification?: string[];
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
  incrementId?: string;
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
  if (!request.task?.trim()) throw new Error("Assignment task is required");
  const timeoutSeconds = request.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new Error("timeoutSeconds must be between 1 and 600");
  }
  const { workflow } = dependencies;
  const observe = (event: Observation): void => {
    try {
      dependencies.observe?.(event);
    } catch {
      /* Observations cannot govern execution. */
    }
  };
  const started = await workflow.startAssignment(request.assignmentId, request.model);
  const { attemptId } = started;
  observe({ type: "attempt.correlated", attemptId });

  let usageReports: ModelUsage[] = [];
  let completion: FinishAttempt = { attemptId, outcome: "failed" };
  let reason: string | undefined;
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
      ...(started.workflow === "implementation"
        ? {
            attemptId,
            workflow: "implementation" as const,
            assignmentId: started.assignmentId,
            incrementId: started.incrementId,
            baseCommit: started.baseCommit,
            criteria: started.criteria,
            verification: started.verification,
          }
        : {}),
      ...(started.selection
        ? { selection: started.selection }
        : started.workflow === "implementation" && started.model
          ? { model: started.model }
          : request.model
            ? { model: request.model }
            : {}),
    });
    usageReports = result.usage ?? [];
    if (result.outcome === "succeeded" || (started.workflow === "implementation" && result.brief)) {
      if (!result.brief?.trim()) throw new Error("Phase artifact is empty");
      const artifactPath = await dependencies.saveBrief(
        request.cwd,
        attemptId,
        result.brief,
        started.artifactPath,
      );
      completion =
        result.outcome === "succeeded"
          ? { attemptId, outcome: "succeeded", artifactPath }
          : { attemptId, outcome: "failed", artifactPath };
    } else {
      completion = { attemptId, outcome: result.outcome };
    }
    reason = result.reason;
  } catch (error) {
    reason = error instanceof Error ? error.message : "assignment execution failed";
    completion = { attemptId, outcome: request.signal.aborted ? "cancelled" : "failed" };
  }
  const settled = await workflow.finishAttempt(completion).catch(async (error: unknown) => {
    // The Pi controller validates before settling. Malformed output becomes a
    // failed attempt; recorder availability does not affect that decision.
    if (!(error instanceof WorkflowValidationError) || !("artifactPath" in completion)) throw error;
    reason = error.message;
    return workflow.finishAttempt({ attemptId, outcome: "failed" });
  });
  observe({ type: "attempt.finished", attemptId, outcome: settled.outcome });
  const gate =
    settled.outcome === "succeeded" && started.workflow !== "implementation"
      ? await workflow.advanceRun()
      : undefined;
  // Usage delivery is observational. It cannot delay settlement, gate evaluation,
  // or the tool response, even if a recorder implementation never resolves.
  for (const usage of usageReports) {
    void Promise.resolve()
      .then(() => workflow.recordUsage?.(attemptId, usage))
      .catch(() => observe({ type: "recording.failed", attemptId }));
  }
  const phase =
    gate?.phase ??
    started.phase ??
    (started.workflow === "implementation" ? "implementation" : "discovery");
  return {
    attemptId,
    outcome: settled.outcome,
    phase,
    ...(gate ? { gate } : {}),
    ...(reason ? { reason } : {}),
    ...(started.workflow === "implementation" ? { incrementId: started.incrementId } : {}),
    artifactId: settled.replayed ? null : settled.artifactId,
    ...(started.workflow === "implementation" &&
    "artifactPath" in completion &&
    !settled.replayed &&
    settled.artifactId
      ? { artifactPath: completion.artifactPath }
      : settled.outcome === "succeeded" && completion.outcome === "succeeded"
        ? { artifactPath: completion.artifactPath }
        : {}),
  };
}
