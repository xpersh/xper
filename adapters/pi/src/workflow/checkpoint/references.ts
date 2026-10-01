import type { ImplementationState } from "../implementation/state.js";
import type { WorkflowState } from "../knowledge/state.js";
import { WorkflowValidationError } from "../types.js";
import type { VerificationState } from "../verification/state.js";
export function validateHistoryReferences(
  knowledge: WorkflowState,
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  artifactIds: Set<string>,
): void {
  for (const [incrementId, history] of Object.entries(implementations)) {
    const reviews = verifications[incrementId] ?? [];
    for (const planArtifactId of new Set(history.map((entry) => entry.planArtifactId))) {
      const planHistory = history.filter((entry) => entry.planArtifactId === planArtifactId);
      const planReviews = reviews.filter((entry) => entry.planArtifactId === planArtifactId);
      if (planReviews.length > planHistory.length)
        throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (const [index, review] of planReviews.entries())
        if (review.implementation.instanceId !== planHistory[index]?.instanceId)
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (let index = 1; index < planHistory.length; index++) {
        const previousImplementation = planHistory[index - 1];
        const previousVerification = planReviews[index - 1];
        const rework = planHistory[index];
        if (
          previousImplementation?.lifecycle.status !== "completed" ||
          previousVerification?.lifecycle.status !== "completed" ||
          previousVerification.lifecycle.verdict !== "rejected" ||
          previousVerification.artifacts[previousVerification.lifecycle.artifactId]
            ?.knowledgeFeedbackReason !== undefined ||
          !rework ||
          rework.baseCommit !== previousVerification.implementation.evaluatedCommit ||
          !rework.assignment.inputs.includes(previousImplementation.lifecycle.artifactId) ||
          !rework.assignment.inputs.includes(previousVerification.lifecycle.artifactId)
        )
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      }
    }
  }
  for (const history of [...Object.values(implementations), ...Object.values(verifications)])
    for (const instance of history)
      if (instance.assignment.inputs.some((id) => !artifactIds.has(id)))
        throw new WorkflowValidationError("invalid delivery checkpoint artifact reference");
  for (const [id, imported] of Object.entries(knowledge.imports)) {
    const owner = Object.values(verifications)
      .flat()
      .map((state) => state.artifacts[id])
      .find(Boolean);
    if (
      !owner ||
      owner.artifact_id !== imported.artifact_id ||
      owner.kind !== imported.kind ||
      owner.path !== imported.path ||
      owner.version !== imported.version ||
      owner.digest !== imported.digest
    )
      throw new WorkflowValidationError("invalid imported knowledge artifact reference");
  }
}
