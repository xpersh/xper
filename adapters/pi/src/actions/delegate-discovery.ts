import type {
  AttemptOutcome,
  FinishAttempt,
  ModelSelection,
  WorkflowClient,
} from "../bridge/xper-client.js";

export type DiscoveryExecutionResult =
  | { outcome: "succeeded"; brief: string }
  | { outcome: Exclude<AttemptOutcome, "succeeded"> };

export interface DiscoveryExecution {
  task: string;
  role: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  model?: string;
  selection?: ModelSelection;
}

type Observation =
  | { type: "attempt.correlated"; attemptId: string }
  | { type: "attempt.finished"; attemptId: string; outcome: AttemptOutcome };

export interface DiscoveryDependencies {
  workflow: Pick<WorkflowClient, "startAssignment" | "finishAttempt" | "advanceRun">;
  execute(request: DiscoveryExecution): Promise<DiscoveryExecutionResult>;
  saveBrief(cwd: string, attemptId: string, brief: string): Promise<string>;
  observe?(event: Observation): void;
}

export interface DelegateDiscoveryRequest {
  task: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSeconds?: number;
  assignmentId?: string;
  model?: string;
}

export interface DelegateDiscoveryResult {
  attemptId: string;
  outcome: AttemptOutcome;
  phase: string;
  artifactId: string | null;
  artifactPath?: string;
}

/** Coordinate local execution; the core owns assignments, outcomes and phase gates. */
export async function delegateDiscovery(
  request: DelegateDiscoveryRequest,
  dependencies: DiscoveryDependencies,
): Promise<DelegateDiscoveryResult> {
  if (!request.task?.trim()) throw new Error("Discovery task is required");
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
      timeoutMs: timeoutSeconds * 1_000,
      ...(started.selection
        ? { selection: started.selection }
        : request.model
          ? { model: request.model }
          : {}),
    });
    if (result.outcome === "succeeded") {
      if (!result.brief.trim()) throw new Error("Discovery Brief is empty");
      const artifactPath = await dependencies.saveBrief(request.cwd, attemptId, result.brief);
      completion = { attemptId, outcome: "succeeded", artifactPath };
    } else {
      completion = { attemptId, outcome: result.outcome };
    }
  } catch {
    completion = { attemptId, outcome: request.signal.aborted ? "cancelled" : "failed" };
  }

  // A bridge failure leaves the durable outcome unknown. Propagate it.
  const settled = await workflow.finishAttempt(completion);
  dependencies.observe?.({ type: "attempt.finished", attemptId, outcome: completion.outcome });
  const phase =
    completion.outcome === "succeeded" ? (await workflow.advanceRun()).phase : "discovery";
  return {
    attemptId,
    outcome: completion.outcome,
    phase,
    artifactId: settled.replayed ? null : settled.artifactId,
    ...(completion.outcome === "succeeded" ? { artifactPath: completion.artifactPath } : {}),
  };
}
