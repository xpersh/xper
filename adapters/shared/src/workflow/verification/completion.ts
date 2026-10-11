import type { FinishAttempt } from "../types.js";
import { invalid } from "../validation.js";
import type { VerificationResult } from "./contract.js";
import type { FactEmitter, Results, VerificationEvent } from "./events.js";
import { parseVerificationResult } from "./result.js";
import type { VerificationState } from "./state.js";

export function finishAttempt(
  state: VerificationState,
  event: Extract<VerificationEvent, { type: "attempt.finish" }>,
  now: number,
  fact: FactEmitter,
): { state: VerificationState; result: Results["attempt.finish"] } {
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
  let report: VerificationResult | undefined;
  if (event.evidence) {
    if (!("artifactPath" in event.result) || event.result.artifactPath !== attempt.artifactPath)
      invalid("artifact path does not match the verification assignment");
    report = parseVerificationResult(event.evidence.content, state);
    if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
    state.artifacts[event.artifactId] = {
      artifact_id: event.artifactId,
      attemptId: event.result.attemptId,
      kind: "verification_result",
      path: event.result.artifactPath,
      version: 1,
      digest: event.evidence.digest,
      inputs: [...state.assignment.inputs],
      verdict: report.output.verdict,
      evaluatedCommit: report.output.evaluatedCommit,
      ...(report.output.rejection?.knowledgeFeedback
        ? { knowledgeFeedbackReason: report.output.rejection.knowledgeFeedback.reason }
        : {}),
    };
    attempt.artifactId = event.artifactId;
    fact("artifact.registered", {
      artifactId: event.artifactId,
      attemptId: event.result.attemptId,
      kind: "verification_result",
      path: event.result.artifactPath,
      digest: event.evidence.digest,
      inputs: state.assignment.inputs,
    });
  }
  if (outcome === "succeeded" && !report) invalid("verification result evidence is required");
  attempt.outcome = outcome;
  fact("attempt.finished", {
    attemptId: event.result.attemptId,
    assignmentId: state.assignment.id,
    outcome,
    durationMs: Math.max(0, now - attempt.startedAt),
  });
  if (outcome === "succeeded" && attempt.artifactId && report) {
    const verdict = report.output.verdict;
    state.lifecycle = { status: "completed", artifactId: attempt.artifactId, verdict };
    fact(verdict === "verified" ? "gate.passed" : "gate.rejected", {
      phase: "verification",
      incrementId: state.incrementId,
      artifactId: attempt.artifactId,
      implementationArtifactId: state.implementation.artifactId,
      evaluatedCommit: state.implementation.evaluatedCommit,
      ...(report.output.rejection ? { rejection: report.output.rejection } : {}),
    });
    if (verdict === "rejected") {
      fact("artifact.invalidated", {
        artifactId: state.implementation.artifactId,
        reasonArtifactId: attempt.artifactId,
      });
      const feedback = report.output.rejection?.knowledgeFeedback;
      if (feedback) {
        fact("knowledge.feedback_requested", {
          sourceAttemptId: event.result.attemptId,
          incrementId: state.incrementId,
          planArtifactId: state.planArtifactId,
          planDigest: state.planDigest,
          verificationArtifactId: attempt.artifactId,
          reason: feedback.reason,
          evidence: report.output.rejection?.evidence,
          paths: report.output.rejection?.paths,
        });
      } else {
        fact("implementation.rework_requested", {
          incrementId: state.incrementId,
          implementationArtifactId: state.implementation.artifactId,
          verificationArtifactId: attempt.artifactId,
          cause: report.output.rejection?.cause,
          evidence: report.output.rejection?.evidence,
        });
      }
    }
    fact("workflow.transition", {
      transitionId: verdict === "verified" ? "verification.accepted" : "verification.rejected",
      from: "verify",
      to: verdict,
      fromVisitId: state.instanceId,
      toVisitId: state.instanceId,
    });
    fact("workflow.completed", {
      incrementId: state.incrementId,
      artifactId: attempt.artifactId,
      outputKind: "verification_result",
      verdict,
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
