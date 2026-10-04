import { humanResolutionFacts, validateResolutionMetadata } from "../judgment/resolution.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { knowledgeChange, type CheckpointChange } from "../checkpoint/update.js";
import type { JudgmentReport } from "../judgment/contract.js";
import { judgmentDefinition } from "../judgment/definition.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import type {
  JudgmentApplied,
  JudgmentReopened,
  JudgmentResolution,
  HumanResolutionMetadata,
} from "../types.js";
import { invalid } from "../validation.js";

export function reopenJudgment(
  previous: AdapterCheckpoint,
  report: JudgmentReport,
  visitId: string,
  now: number,
  human?: JudgmentResolution,
  metadata: HumanResolutionMetadata = {},
): CheckpointChange<JudgmentApplied> {
  const checkpoint = structuredClone(previous);
  const judgment = checkpoint.judgment;
  const artifact = judgment?.report;
  const authorization = checkpoint.authorizedPlan;
  const verdict = human?.decision ?? report.output.verdict;
  if (
    !judgment ||
    !artifact ||
    !authorization ||
    !["REWORK_IMPLEMENTATION", "REVISIT_DESIGN", "REDEFINE"].includes(verdict)
  )
    invalid("Judge feedback requires an applicable report and authorized Plan");
  const phase =
    verdict === "REWORK_IMPLEMENTATION"
      ? "implementation"
      : verdict === "REDEFINE"
        ? "define"
        : "design";
  const decision: JudgmentReopened = {
    ...metadata,
    reportId: artifact.artifact_id,
    reportDigest: artifact.digest,
    planArtifactId: judgment.evaluation.planArtifactId,
    evaluatedCommit: judgment.evaluation.evaluatedCommit,
    verdict: verdict as JudgmentReopened["verdict"],
    status: "reopened",
    phase,
    incrementIds: [...judgment.evaluation.incrementIds],
    appliedAt: now,
  };
  validateResolutionMetadata({ ...decision }, report.output.verdict, artifact.artifact_id, now);
  checkpoint.judgmentHistory.push({
    state: judgment,
    decision,
    authorization: structuredClone(authorization),
    accepted: structuredClone(checkpoint.knowledge.accepted),
  });
  checkpoint.judgment = null;
  const facts: CheckpointChange<JudgmentApplied>["facts"] = [
    ...humanResolutionFacts(decision),
    { type: "judgment.applied", data: { ...decision } },
    ...judgment.evaluation.artifacts
      .filter((input) => input.kind === "verification_result")
      .map((input) => ({
        type: "artifact.invalidated",
        data: {
          artifactId: input.artifact_id,
          reasonArtifactId: decision.reportId,
          reason: "Judge feedback requires fresh delivery evidence",
        },
      })),
  ];
  const result: JudgmentApplied = {
    ...decision,
    runId: checkpoint.knowledge.run_id,
    replayed: false,
  };
  if (phase === "implementation") {
    checkpoint.authorizedPlan = {
      ...authorization,
      baseCommit: decision.evaluatedCommit,
      reworkReportId: decision.reportId,
    };
    facts.push({ type: "implementation.rework_requested", data: { ...decision } });
    return {
      state: checkpoint,
      facts,
      result,
      definition: judgmentDefinition,
      context: { runId: judgment.runId, instanceId: judgment.instanceId },
    };
  }
  const reason = phase === "define" ? "ambiguous_criteria" : "infeasible_design";
  const transition = transitionKnowledge(
    checkpoint.knowledge,
    {
      type: "delivery.feedback",
      nextVisitId: visitId,
      sourceAttemptId: artifact.attemptId,
      incrementIds: decision.incrementIds,
      planArtifactId: authorization.artifactId,
      planDigest: authorization.digest,
      reason,
      evidence: human?.reason ?? report.output.reason,
      paths: [],
      artifact,
      ...(metadata.resolution ? { resolution: metadata.resolution } : {}),
    },
    now,
  );
  checkpoint.reconciliations.push({
    judgmentArtifactId: decision.reportId,
    sourceAttemptId: artifact.attemptId,
    incrementIds: decision.incrementIds,
    reason,
    previousPlanArtifactId: authorization.artifactId,
    previousPlanDigest: authorization.digest,
    revisedPlanArtifactId: null,
    invalidatedVerificationArtifactIds: [],
    status: "revisiting",
    resumeCommit: null,
  });
  const change = knowledgeChange(checkpoint, transition);
  return { ...change, facts: [...facts, ...change.facts], result };
}
