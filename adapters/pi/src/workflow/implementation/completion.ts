import type { FinishAttempt } from "../types.js";
import { invalid } from "../validation.js";
import type { FactEmitter, ImplementationEvent, ImplementationResultByEvent } from "./events.js";
import type { ImplementationResult } from "./result.js";
import { parseImplementationResult } from "./result.js";
import type { ImplementationState } from "./state.js";

export function finishAttempt(
  state: ImplementationState,
  event: Extract<ImplementationEvent, { type: "attempt.finish" }>,
  now: number,
  fact: FactEmitter,
): { state: ImplementationState; result: ImplementationResultByEvent["attempt.finish"] } {
  const attempt = state.attempts[event.result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  if (attempt.outcome !== null) {
    if (
      attempt.outcome !== event.result.outcome &&
      !(event.result.outcome === "succeeded" && attempt.outcome === "timed_out")
    )
      invalid("attempt already has a different outcome");
    return {
      state,
      result: {
        attemptId: event.result.attemptId,
        outcome: attempt.outcome as FinishAttempt["outcome"],
        replayed: true,
      },
    };
  }
  const late = event.result.outcome === "succeeded" && now - attempt.startedAt >= attempt.timeoutMs;
  const outcome = late ? "timed_out" : event.result.outcome;
  let report: ImplementationResult | undefined;
  if (event.evidence) {
    if (!("artifactPath" in event.result) || event.result.artifactPath !== attempt.artifactPath)
      invalid("artifact path does not match the implementation assignment");
    report = parseImplementationResult(event.evidence.content, state);
    if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
    state.artifacts[event.artifactId] = {
      artifact_id: event.artifactId,
      attemptId: event.result.attemptId,
      kind: "implementation_result",
      path: event.result.artifactPath,
      version: 1,
      digest: event.evidence.digest,
      inputs: [...state.assignment.inputs],
      resultingCommit: report.output.resultingCommit,
    };
    attempt.artifactId = event.artifactId;
    fact("artifact.registered", {
      artifactId: event.artifactId,
      attemptId: event.result.attemptId,
      kind: "implementation_result",
      path: event.result.artifactPath,
      digest: event.evidence.digest,
      inputs: state.assignment.inputs,
    });
  }
  if (outcome === "succeeded") {
    if (!report) invalid("implementation result evidence is required");
    if (report.output.tests.some((test) => test.exitCode !== 0))
      invalid("host-run implementation tests did not pass");
  }
  attempt.outcome = outcome;
  fact("attempt.finished", {
    attemptId: event.result.attemptId,
    assignmentId: state.assignment.id,
    outcome,
    durationMs: Math.max(0, now - attempt.startedAt),
  });
  if (outcome === "succeeded" && attempt.artifactId) {
    state.lifecycle = { status: "completed", artifactId: attempt.artifactId };
    fact("gate.passed", {
      phase: "implementation",
      incrementId: state.incrementId,
      artifactId: attempt.artifactId,
    });
    fact("workflow.transition", {
      transitionId: "implementation.accepted",
      from: "implement",
      to: "implemented",
      fromVisitId: state.instanceId,
      toVisitId: state.instanceId,
    });
    fact("workflow.completed", {
      incrementId: state.incrementId,
      artifactId: attempt.artifactId,
      outputKind: "implementation_result",
    });
  }
  return {
    state,
    result: {
      attemptId: event.result.attemptId,
      outcome,
      artifactId: attempt.artifactId,
      ...(outcome === "succeeded" ? { workflowCompleted: true } : {}),
    },
  };
}
