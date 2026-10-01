import { feedbackArtifactId } from "../delivery/cycle.js";
import type { AdapterCheckpoint } from "./types.js";
import type { ImplementationState } from "../implementation/state.js";
import type { WorkflowState } from "../knowledge/state.js";
import { WorkflowValidationError } from "../types.js";
import { commit } from "../validation.js";
import type { VerificationState } from "../verification/state.js";
import type { DeliveryPlanAuthorization, DeliveryReconciliation } from "./types.js";
export function validateReconciliations(
  knowledge: WorkflowState,
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  authorizedPlan: DeliveryPlanAuthorization | null,
  reconciliations: DeliveryReconciliation[],
  judgments: AdapterCheckpoint["judgmentHistory"] = [],
): void {
  if (authorizedPlan) {
    const plan = knowledge.artifacts[authorizedPlan.artifactId];
    if (
      !plan ||
      plan.digest !== authorizedPlan.digest ||
      (authorizedPlan.baseCommit !== null && !commit(authorizedPlan.baseCommit))
    )
      throw new WorkflowValidationError("invalid authorized delivery Plan");
  } else if (Object.keys(implementations).length || Object.keys(verifications).length) {
    throw new WorkflowValidationError("delivery history has no authorized Plan");
  }
  const seenFeedback = new Set<string>();
  for (const [index, reconciliation] of reconciliations.entries()) {
    const sourceId = feedbackArtifactId(reconciliation);
    const judge = judgments.find(
      (entry) => entry.decision.reportId === reconciliation.judgmentArtifactId,
    );
    const verification = Object.values(verifications)
      .flat()
      .find((state) => Object.hasOwn(state.artifacts, sourceId));
    const artifact = judge?.state.report ?? verification?.artifacts[sourceId];
    const imported = knowledge.imports[sourceId];
    const sourceMatches = judge
      ? reconciliation.verificationArtifactId === undefined &&
        judge.decision.phase ===
          (reconciliation.reason === "ambiguous_criteria" ? "define" : "design") &&
        judge.decision.planArtifactId === reconciliation.previousPlanArtifactId &&
        JSON.stringify(judge.decision.incrementIds) === JSON.stringify(reconciliation.incrementIds)
      : reconciliation.judgmentArtifactId === undefined &&
        verification?.incrementId === reconciliation.incrementId &&
        verification?.planArtifactId === reconciliation.previousPlanArtifactId &&
        verification.planDigest === reconciliation.previousPlanDigest &&
        verification.artifacts[sourceId]?.knowledgeFeedbackReason === reconciliation.reason;
    const previousPlan = knowledge.artifacts[reconciliation.previousPlanArtifactId];
    const preceding = reconciliations[index - 1];
    const expectedInvalidated = Object.values(verifications)
      .flat()
      .filter(
        (state) =>
          state.planArtifactId === reconciliation.previousPlanArtifactId &&
          state.lifecycle.status === "completed" &&
          state.lifecycle.verdict === "verified",
      )
      .map((state) => (state.lifecycle.status === "completed" ? state.lifecycle.artifactId : ""));
    const invalidated = new Set(reconciliation.invalidatedVerificationArtifactIds);
    if (
      seenFeedback.has(sourceId) ||
      !sourceMatches ||
      !artifact ||
      !imported ||
      imported.artifact_id !== artifact.artifact_id ||
      imported.kind !== artifact.kind ||
      imported.path !== artifact.path ||
      imported.version !== artifact.version ||
      imported.digest !== artifact.digest ||
      artifact.attemptId !== reconciliation.sourceAttemptId ||
      !previousPlan ||
      previousPlan.digest !== reconciliation.previousPlanDigest ||
      !["revisiting", "awaiting_resume", "resumed"].includes(reconciliation.status) ||
      (reconciliation.revisedPlanArtifactId !== null &&
        !knowledge.artifacts[reconciliation.revisedPlanArtifactId]) ||
      !Array.isArray(reconciliation.invalidatedVerificationArtifactIds) ||
      invalidated.size !== reconciliation.invalidatedVerificationArtifactIds.length ||
      (reconciliation.status === "revisiting"
        ? invalidated.size !== 0
        : invalidated.size !== expectedInvalidated.length ||
          expectedInvalidated.some((id) => !invalidated.has(id))) ||
      (reconciliation.resumeCommit !== null && !commit(reconciliation.resumeCommit)) ||
      (reconciliation.status === "revisiting" &&
        (reconciliation.revisedPlanArtifactId !== null || reconciliation.resumeCommit !== null)) ||
      (reconciliation.status === "awaiting_resume" &&
        (reconciliation.revisedPlanArtifactId === null || reconciliation.resumeCommit !== null)) ||
      (reconciliation.status === "resumed" &&
        (reconciliation.revisedPlanArtifactId === null || reconciliation.resumeCommit === null)) ||
      (preceding &&
        (preceding.status !== "resumed" ||
          preceding.revisedPlanArtifactId !== reconciliation.previousPlanArtifactId)) ||
      (index < reconciliations.length - 1 && reconciliation.status !== "resumed")
    )
      throw new WorkflowValidationError("invalid delivery reconciliation");
    seenFeedback.add(sourceId);
  }
  if (Object.keys(knowledge.imports).some((id) => !seenFeedback.has(id)))
    throw new WorkflowValidationError("invalid imported knowledge artifact reference");
  const currentReconciliation = reconciliations.at(-1);
  const expectedAuthorizedPlan = currentReconciliation
    ? currentReconciliation.status === "resumed"
      ? currentReconciliation.revisedPlanArtifactId
      : currentReconciliation.previousPlanArtifactId
    : knowledge.lifecycle.status === "completed"
      ? knowledge.lifecycle.artifactId
      : null;
  if ((authorizedPlan?.artifactId ?? null) !== expectedAuthorizedPlan)
    throw new WorkflowValidationError("invalid authorized delivery Plan");
  if (
    currentReconciliation?.status !== "revisiting" &&
    currentReconciliation &&
    (knowledge.lifecycle.status !== "completed" ||
      knowledge.lifecycle.artifactId !== currentReconciliation.revisedPlanArtifactId)
  )
    throw new WorkflowValidationError("invalid delivery reconciliation");
}
