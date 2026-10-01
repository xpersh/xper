import type { AdapterCheckpoint, DeliveryReconciliation } from "../checkpoint/types.js";
import { invalid } from "../validation.js";
import type { VerificationState } from "../verification/state.js";
export function verificationFeedback(verification: VerificationState) {
  if (verification.lifecycle.status !== "completed") return null;
  const artifact = verification.artifacts[verification.lifecycle.artifactId];
  if (!artifact?.knowledgeFeedbackReason) return null;
  const attempt = verification.attempts[artifact.attemptId];
  if (attempt?.outcome !== "succeeded")
    invalid("knowledge feedback has no successful source attempt");
  return { artifact, attemptId: artifact.attemptId, reason: artifact.knowledgeFeedbackReason };
}
export function currentReconciliation(
  checkpoint: AdapterCheckpoint,
): DeliveryReconciliation | undefined {
  return checkpoint.reconciliations.findLast((candidate) => candidate.status !== "resumed");
}
export function verifiedArtifactsForPlan(
  checkpoint: AdapterCheckpoint,
  planArtifactId: string,
): string[] {
  return Object.values(checkpoint.verifications)
    .flat()
    .filter(
      (verification) =>
        verification.planArtifactId === planArtifactId &&
        verification.lifecycle.status === "completed" &&
        verification.lifecycle.verdict === "verified",
    )
    .map((verification) =>
      verification.lifecycle.status === "completed" ? verification.lifecycle.artifactId : "",
    );
}
