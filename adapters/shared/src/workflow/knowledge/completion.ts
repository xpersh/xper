import { contracts } from "../policy.js";
import type { FinishAttempt } from "../types.js";
import { invalid } from "../validation.js";
import type { Document } from "./contract.js";
import { parseDocument } from "./contracts.js";
import type { FactEmitter, KnowledgeEvent, Results } from "./events.js";
import { attemptOutcome } from "./selectors.js";
import type { WorkflowState } from "./state.js";

export function finishAttempt(
  state: WorkflowState,
  event: Extract<KnowledgeEvent, { type: "attempt.finish" }>,
  now: number,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["attempt.finish"] } {
  const { result } = event,
    attempt = state.attempts[result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  if (attempt.outcome !== null) {
    if (
      attempt.outcome !== result.outcome &&
      !(result.outcome === "succeeded" && attempt.outcome === "timed_out")
    )
      invalid("attempt already has a different outcome");
    if (result.outcome === "succeeded" && result.artifactPath !== attempt.artifactPath)
      invalid("artifact path does not match the assignment");
    return {
      state,
      result: {
        attemptId: result.attemptId,
        outcome: attempt.outcome as FinishAttempt["outcome"],
        replayed: true,
      },
    };
  }
  const outcome = attemptOutcome(state, result, now);
  const assignment = state.assignments[attempt.assignmentId];
  if (!assignment) invalid("assignment is not registered");
  if (outcome === "succeeded" && result.outcome === "succeeded") {
    if (result.artifactPath !== attempt.artifactPath)
      invalid("artifact path does not match the assignment");
    const evidence = event.evidence;
    if (!evidence) invalid("artifact evidence is required");
    if (!evidence.content.trim() || !evidence.digest.trim()) invalid("artifact evidence is empty");
    let document: Document | null;
    try {
      document =
        assignment.phase === "discovery"
          ? null
          : parseDocument(evidence.content, assignment.inputs);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "invalid artifact");
    }
    const kind = document?.output.kind ?? "discovery_brief";
    if (kind !== contracts[assignment.phase].kind && kind !== "feedback")
      invalid("artifact kind does not match the current phase");
    if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
    state.artifacts[event.artifactId] = {
      artifact_id: event.artifactId,
      attemptId: result.attemptId,
      kind,
      path: result.artifactPath,
      version: 1,
      digest: evidence.digest,
      inputs: [...assignment.inputs],
    };
    attempt.artifactId = event.artifactId;
    fact("artifact.registered", {
      artifactId: event.artifactId,
      attemptId: result.attemptId,
      kind,
      path: result.artifactPath,
      digest: evidence.digest,
      inputs: assignment.inputs,
    });
  }
  attempt.outcome = outcome;
  fact("attempt.finished", {
    attemptId: result.attemptId,
    assignmentId: attempt.assignmentId,
    outcome,
    durationMs: Math.max(0, now - attempt.startedAt),
  });
  return {
    state,
    result: { attemptId: result.attemptId, outcome, artifactId: attempt.artifactId },
  };
}
