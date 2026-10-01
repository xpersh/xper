import type { FinishAttempt, ModelUsage } from "../workflow/types.js";
import { WorkflowValidationError } from "../workflow/types.js";
import type {
  DelegationDependencies,
  DelegationRequest,
  DelegationResult,
  Observation,
} from "./delegation.js";
import { prepareExecution } from "./prepare-execution.js";

export async function delegateWorkflow(
  request: DelegationRequest,
  dependencies: DelegationDependencies,
): Promise<DelegationResult> {
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
  const delivery = started.workflow === "implementation" || started.workflow === "verification";
  observe({ type: "attempt.correlated", attemptId });

  let usageReports: ModelUsage[] = [];
  let completion: FinishAttempt = { attemptId, outcome: "failed" };
  let reason: string | undefined;
  try {
    const result = await dependencies.execute(prepareExecution(request, started, timeoutSeconds));
    usageReports = result.usage ?? [];
    if (result.outcome === "succeeded" || (delivery && result.brief)) {
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
    settled.outcome === "succeeded" && !delivery && started.workflow !== "judgment"
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
    settled.handoffPhase ??
    gate?.phase ??
    started.phase ??
    (delivery ? started.workflow : "discovery");
  return {
    attemptId,
    outcome: settled.outcome,
    phase,
    ...(gate ? { gate } : {}),
    ...(reason ? { reason } : {}),
    ...(settled.judgment ? { judgment: settled.judgment } : {}),
    ...(delivery ? { incrementId: started.incrementId } : {}),
    artifactId: settled.replayed ? null : settled.artifactId,
    ...(delivery && "artifactPath" in completion && !settled.replayed && settled.artifactId
      ? { artifactPath: completion.artifactPath }
      : settled.outcome === "succeeded" && completion.outcome === "succeeded"
        ? { artifactPath: completion.artifactPath }
        : {}),
  };
}
