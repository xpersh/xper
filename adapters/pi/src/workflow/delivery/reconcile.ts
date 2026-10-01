import { feedbackArtifactId } from "./cycle.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { knowledgeChange, type CheckpointChange } from "../checkpoint/update.js";
import { knowledgeDefinition } from "../knowledge/definition.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import type { RunAdvanced } from "../types.js";
import { invalid } from "../validation.js";
import type { VerificationState } from "../verification/state.js";
import {
  currentReconciliation,
  verificationFeedback,
  verifiedArtifactsForPlan,
} from "./reconciliation.js";

import type { VerificationResult } from "../verification/contract.js";
export function requireFeedbackReport(verification: VerificationState, report: VerificationResult) {
  const feedback = verificationFeedback(verification);
  if (!feedback) invalid("verification has no Knowledge feedback");
  const rejection = report.output.rejection;
  if (!rejection?.knowledgeFeedback || rejection.knowledgeFeedback.reason !== feedback.reason)
    invalid("verification feedback metadata does not match its artifact");
  return { feedback, rejection };
}
export function feedbackReplay(
  checkpoint: AdapterCheckpoint,
  verification: VerificationState,
): RunAdvanced | null {
  const feedback = verificationFeedback(verification);
  if (!feedback) return null;
  const existing = checkpoint.reconciliations.find(
    (candidate) => candidate.verificationArtifactId === feedback.artifact.artifact_id,
  );
  return existing && checkpoint.knowledge.imports[feedback.artifact.artifact_id]
    ? {
        advanced: true,
        phase: feedback.reason === "ambiguous_criteria" ? "define" : "design",
        resumed: true,
      }
    : null;
}
export function knowledgeFeedbackChange(
  previous: AdapterCheckpoint,
  verification: VerificationState,
  report: VerificationResult,
  nextVisitId: string,
  now: number,
): CheckpointChange<RunAdvanced> {
  const checkpoint = structuredClone(previous);
  const { feedback, rejection } = requireFeedbackReport(verification, report);
  const existing = checkpoint.reconciliations.find(
    (candidate) => candidate.verificationArtifactId === feedback.artifact.artifact_id,
  );
  const transition = transitionKnowledge(
    checkpoint.knowledge,
    {
      type: "delivery.feedback",
      nextVisitId: nextVisitId,
      sourceAttemptId: feedback.attemptId,
      incrementId: verification.incrementId,
      planArtifactId: verification.planArtifactId,
      planDigest: verification.planDigest,
      reason: feedback.reason,
      evidence: rejection.evidence,
      paths: rejection.paths,
      artifact: {
        artifact_id: feedback.artifact.artifact_id,
        kind: feedback.artifact.kind,
        path: feedback.artifact.path,
        version: feedback.artifact.version,
        digest: feedback.artifact.digest,
      },
    },
    now,
  );
  if (!existing) {
    checkpoint.reconciliations.push({
      verificationArtifactId: feedback.artifact.artifact_id,
      sourceAttemptId: feedback.attemptId,
      incrementId: verification.incrementId,
      reason: feedback.reason,
      previousPlanArtifactId: verification.planArtifactId,
      previousPlanDigest: verification.planDigest,
      revisedPlanArtifactId: null,
      invalidatedVerificationArtifactIds: [],
      status: "revisiting",
      resumeCommit: null,
    });
  }
  return knowledgeChange(checkpoint, transition);
}
export function reconciliationAwaitingChange(
  previous: AdapterCheckpoint,
): CheckpointChange<boolean> | null {
  const checkpoint = structuredClone(previous);
  const reconciliation = currentReconciliation(checkpoint);
  const knowledge = checkpoint.knowledge;
  if (reconciliation?.status !== "revisiting") return null;
  if (knowledge.lifecycle.status !== "completed") return null;
  const revisedPlanArtifactId = knowledge.lifecycle.artifactId;
  if (revisedPlanArtifactId === reconciliation.previousPlanArtifactId)
    invalid("a Knowledge revisit must seal a new Plan artifact");
  const invalidated = verifiedArtifactsForPlan(checkpoint, reconciliation.previousPlanArtifactId);
  reconciliation.revisedPlanArtifactId = revisedPlanArtifactId;
  reconciliation.invalidatedVerificationArtifactIds = invalidated;
  reconciliation.status = "awaiting_resume";
  const facts = [
    ...invalidated.map((artifactId) => ({
      type: "artifact.invalidated",
      data: {
        artifactId,
        reasonArtifactId: feedbackArtifactId(reconciliation),
        reason: "revised Plan requires fresh delivery evidence",
      },
    })),
    {
      type: "delivery.reconciliation_required",
      data: {
        ...(reconciliation.judgmentArtifactId
          ? { judgmentArtifactId: reconciliation.judgmentArtifactId }
          : { verificationArtifactId: reconciliation.verificationArtifactId }),
        previousPlanArtifactId: reconciliation.previousPlanArtifactId,
        revisedPlanArtifactId,
      },
    },
  ];
  return {
    state: checkpoint,
    facts,
    result: true,
    definition: knowledgeDefinition,
    context: { runId: knowledge.run_id, instanceId: knowledge.instanceId },
  };
}
