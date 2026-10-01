import type { ImplementationState } from "../implementation/state.js";
import { WorkflowValidationError } from "../types.js";
import type { VerificationState } from "../verification/state.js";

export function verifiedDeliveryTip(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  planArtifactId?: string,
): string | null {
  const verifiedEdges = new Map<string, string>();
  const evaluatedCommits = new Set<string>();
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = planArtifactId
      ? history.findLast((candidate) => candidate.planArtifactId === planArtifactId)
      : history.at(-1);
    if (!implementation) continue;
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === implementation.planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
    );
    if (verification?.lifecycle.status !== "completed") continue;
    if (verification.lifecycle.verdict !== "verified") continue;
    const { baseCommit, evaluatedCommit } = verification.implementation;
    if (verifiedEdges.has(baseCommit) || evaluatedCommits.has(evaluatedCommit))
      throw new WorkflowValidationError("invalid sequential delivery checkpoint");
    verifiedEdges.set(baseCommit, evaluatedCommit);
    evaluatedCommits.add(evaluatedCommit);
  }
  if (!verifiedEdges.size) return null;
  const roots = [...verifiedEdges.keys()].filter((commit) => !evaluatedCommits.has(commit));
  if (roots.length !== 1)
    throw new WorkflowValidationError("invalid sequential delivery checkpoint");
  let commit = roots[0] as string;
  const visited = new Set<string>();
  while (verifiedEdges.has(commit)) {
    if (visited.has(commit))
      throw new WorkflowValidationError("invalid sequential delivery checkpoint");
    visited.add(commit);
    commit = verifiedEdges.get(commit) as string;
  }
  if (visited.size !== verifiedEdges.size)
    throw new WorkflowValidationError("invalid sequential delivery checkpoint");
  return commit;
}

export function validateSerialDelivery(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  activePlanArtifactId: string | null,
): void {
  let frontiers = 0;
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = activePlanArtifactId
      ? history.findLast((candidate) => candidate.planArtifactId === activePlanArtifactId)
      : undefined;
    if (!implementation) continue;
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === implementation.planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
    );
    if (
      implementation.lifecycle.status === "active" ||
      !verification ||
      verification.lifecycle.status === "active" ||
      verification.lifecycle.verdict === "rejected"
    )
      frontiers++;
  }
  if (frontiers > 1) throw new WorkflowValidationError("invalid overlapping delivery checkpoint");
  const plans = new Set(
    Object.values(implementations)
      .flat()
      .map((implementation) => implementation.planArtifactId),
  );
  for (const plan of plans) verifiedDeliveryTip(implementations, verifications, plan);
}
