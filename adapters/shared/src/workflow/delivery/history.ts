import type { ImplementationState } from "../implementation/state.js";
import { WorkflowValidationError } from "../types.js";
import type { VerificationState } from "../verification/state.js";

export function verifiedDeliveryTip(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  planArtifactId?: string,
  expectedBaseCommit?: string | null,
): string | null {
  const verifiedEdges = new Map<string, string>();
  const evaluatedCommits = new Set<string>();
  const unchanged = new Set<string>();
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
    if (baseCommit === evaluatedCommit && implementation.reworkReportId) {
      unchanged.add(baseCommit);
      continue;
    }
    if (verifiedEdges.has(baseCommit) || evaluatedCommits.has(evaluatedCommit))
      throw new WorkflowValidationError("invalid sequential delivery checkpoint");
    verifiedEdges.set(baseCommit, evaluatedCommit);
    evaluatedCommits.add(evaluatedCommit);
  }
  if (!verifiedEdges.size) {
    if (
      unchanged.size > 1 ||
      (unchanged.size && expectedBaseCommit && !unchanged.has(expectedBaseCommit))
    )
      throw new WorkflowValidationError("invalid sequential revalidation checkpoint");
    return [...unchanged][0] ?? null;
  }
  const roots = [...verifiedEdges.keys()].filter((commit) => !evaluatedCommits.has(commit));
  if (roots.length !== 1 || (expectedBaseCommit && roots[0] !== expectedBaseCommit))
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
  if ([...unchanged].some((revision) => revision !== commit && !visited.has(revision)))
    throw new WorkflowValidationError("invalid sequential revalidation checkpoint");
  return commit;
}

export function validateSerialDelivery(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  activePlanArtifactId: string | null,
  activeReworkReportId?: string,
): void {
  let frontiers = 0;
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = activePlanArtifactId
      ? history.findLast(
          (candidate) =>
            candidate.planArtifactId === activePlanArtifactId &&
            candidate.reworkReportId === activeReworkReportId,
        )
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
  for (const plan of plans) {
    const cycles = new Set(
      Object.values(implementations)
        .flat()
        .filter((state) => state.planArtifactId === plan)
        .map((state) => state.reworkReportId),
    );
    for (const cycle of cycles)
      verifiedDeliveryTip(
        Object.fromEntries(
          Object.entries(implementations).map(([id, history]) => [
            id,
            history.filter((state) => state.reworkReportId === cycle),
          ]),
        ),
        verifications,
        plan,
      );
  }
}
