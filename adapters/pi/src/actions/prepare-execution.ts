import type { StartedAssignment } from "../workflow/types.js";
import type { DelegationRequest } from "./delegation.js";
import type { ExecutionRequest } from "./execution.js";
export function prepareExecution(
  request: DelegationRequest,
  started: StartedAssignment,
  timeoutSeconds: number,
): ExecutionRequest {
  const delivery = started.workflow === "implementation" || started.workflow === "verification";
  const common = {
    task: request.task,
    cwd: request.cwd,
    role: started.role,
    signal: request.signal,
    timeoutMs: Math.min(timeoutSeconds * 1000, started.timeoutMs ?? Infinity),
    ...(started.inputArtifacts ? { inputArtifacts: started.inputArtifacts } : {}),
    ...(started.artifactKind ? { artifactKind: started.artifactKind } : {}),
    ...(started.budget ? { budget: started.budget } : {}),
    ...(started.selection
      ? { selection: started.selection }
      : (delivery || started.workflow === "judgment") && started.model
        ? { model: started.model }
        : request.model
          ? { model: request.model }
          : {}),
  };
  if (started.workflow === "judgment")
    return {
      ...common,
      workflow: "judgment",
      assignmentId: started.assignmentId,
      evaluation: started.evaluation,
    };
  if (!delivery) return { ...common, workflow: "knowledge" };
  const details = {
    ...common,
    attemptId: started.attemptId,
    assignmentId: started.assignmentId,
    incrementId: started.incrementId,
    baseCommit: started.baseCommit,
    criteria: started.criteria,
    verification: started.verification,
  };
  return started.workflow === "verification"
    ? {
        ...details,
        workflow: "verification",
        evaluatedCommit: started.evaluatedCommit,
        implementationArtifactId: started.implementationArtifactId,
        implementationTestCommands: started.implementationTestCommands,
      }
    : { ...details, workflow: "implementation" };
}
