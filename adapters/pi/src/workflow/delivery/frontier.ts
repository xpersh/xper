import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { ImplementationState } from "../implementation/state.js";
import { invalid } from "../validation.js";
import type { VerificationState } from "../verification/state.js";
import { currentReconciliation, verificationFeedback } from "./reconciliation.js";
export type DeliveryFrontier =
  | {
      kind: "implementation";
      implementation: ImplementationState;
      rejected?: VerificationState;
    }
  | {
      kind: "verification";
      implementation: ImplementationState;
      verification?: VerificationState;
    };
export function deliveryFrontier(checkpoint: AdapterCheckpoint): DeliveryFrontier | null {
  const planArtifactId = checkpoint.authorizedPlan?.artifactId;
  if (!planArtifactId) return null;
  const frontiers: DeliveryFrontier[] = [];
  for (const [incrementId, history] of Object.entries(checkpoint.implementations)) {
    const implementation = history.findLast(
      (candidate) => candidate.planArtifactId === planArtifactId,
    );
    if (!implementation) continue;
    if (implementation.lifecycle.status === "active") {
      frontiers.push({ kind: "implementation", implementation });
      continue;
    }
    const verification = (checkpoint.verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
    );
    if (!verification || verification.lifecycle.status === "active") {
      frontiers.push({
        kind: "verification",
        implementation,
        ...(verification ? { verification } : {}),
      });
      continue;
    }
    if (verification.lifecycle.verdict === "rejected")
      if (!verificationFeedback(verification))
        frontiers.push({ kind: "implementation", implementation, rejected: verification });
  }
  if (frontiers.length > 1) invalid("delivery checkpoint has overlapping increment frontiers");
  return frontiers[0] ?? null;
}
export function satisfiedAssignmentArtifacts(checkpoint: AdapterCheckpoint): Map<string, string> {
  const planArtifactId = checkpoint.authorizedPlan?.artifactId;
  const satisfied = new Map<string, string>();
  if (!planArtifactId) return satisfied;
  for (const [incrementId, history] of Object.entries(checkpoint.implementations)) {
    const implementation = history.findLast(
      (candidate) => candidate.planArtifactId === planArtifactId,
    );
    if (implementation?.lifecycle.status !== "completed") continue;
    satisfied.set(implementation.assignment.id, implementation.lifecycle.artifactId);
    const verification = (checkpoint.verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
    );
    if (verification?.lifecycle.status !== "completed") continue;
    if (verification.lifecycle.verdict !== "verified") continue;
    satisfied.set(verification.assignment.id, verification.lifecycle.artifactId);
  }
  return satisfied;
}

export function assertDeliveryReady(checkpoint: AdapterCheckpoint): void {
  const acceptedPlanId = checkpoint.knowledge.accepted.plan;
  if (!checkpoint.authorizedPlan || checkpoint.authorizedPlan.artifactId !== acceptedPlanId)
    invalid("the revised Plan requires /xper resume <commit> before delivery");
  if (currentReconciliation(checkpoint)?.status === "awaiting_resume")
    invalid("the revised Plan requires /xper resume <commit> before delivery");
}
