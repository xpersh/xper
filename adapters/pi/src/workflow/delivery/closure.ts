import { humanResolutionFacts } from "../judgment/resolution.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { decodeClosure } from "../checkpoint/closure.js";
import type { CheckpointChange } from "../checkpoint/update.js";
import { judgmentDefinition } from "../judgment/definition.js";
import type {
  ArtifactInput,
  JudgmentApplied,
  RunClosure,
  JudgmentResolution,
  HumanResolutionMetadata,
} from "../types.js";
import { invalid } from "../validation.js";
import { validateJudgmentReferences } from "./judgment.js";
import { validateResumeRevision } from "./resume.js";

export function assertRunOpen(checkpoint: AdapterCheckpoint | null): void {
  if (checkpoint?.closure) invalid("run is closed; start a new Pi session for another objective");
}

export function judgmentReplay(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  revision: string,
): JudgmentApplied | null {
  validateResumeRevision(revision);
  const historical = checkpoint.judgmentHistory.find(
    (entry) => entry.decision.reportId === reportId,
  );
  if (historical) {
    if (historical.decision.evaluatedCommit !== revision)
      invalid("approval must identify the exact Judge report and evaluated commit");
    return {
      ...structuredClone(historical.decision),
      runId: checkpoint.knowledge.run_id,
      replayed: true,
    };
  }
  const report = checkpoint.judgment?.report;
  if (
    !report ||
    report.artifact_id !== reportId ||
    checkpoint.judgment?.evaluation.evaluatedCommit !== revision
  )
    invalid("approval must identify the exact Judge report and evaluated commit");
  if (checkpoint.closure)
    return {
      ...structuredClone(checkpoint.closure),
      runId: checkpoint.knowledge.run_id,
      replayed: true,
    };
  validateJudgmentReferences(checkpoint);
  return null;
}

export function closeRun(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  revision: string,
  summary: ArtifactInput & { digest: string },
  now: number,
  human?: JudgmentResolution,
  metadata: HumanResolutionMetadata = {},
): CheckpointChange<JudgmentApplied> {
  const replay = judgmentReplay(checkpoint, reportId, revision);
  const judgment = checkpoint.judgment;
  if (!judgment?.report) invalid("Judge report is required");
  const context = { runId: checkpoint.knowledge.run_id, instanceId: judgment.instanceId };
  if (replay)
    return {
      state: structuredClone(checkpoint),
      facts: [],
      result: replay,
      definition: judgmentDefinition,
      context,
    };
  const report = judgment.report;
  const verdict = human?.decision ?? report.verdict;
  if (verdict !== "ACCEPT" && verdict !== "ACCEPT_WITH_DEBT" && verdict !== "REJECT")
    invalid("unsupported verdict");
  const closure: RunClosure = {
    reportId,
    reportDigest: report.digest,
    planArtifactId: judgment.evaluation.planArtifactId,
    evaluatedCommit: revision,
    ...metadata,
    verdict,
    status:
      verdict === "ACCEPT"
        ? "accepted"
        : verdict === "ACCEPT_WITH_DEBT"
          ? "accepted_with_debt"
          : "rejected",
    incrementIds: [...judgment.evaluation.incrementIds],
    closedAt: now,
    summary: structuredClone(summary),
  };
  decodeClosure(closure, checkpoint);
  const references = {
    reportId,
    planArtifactId: closure.planArtifactId,
    evaluatedCommit: revision,
    ...(metadata.resolution
      ? {
          recommendation: metadata.recommendation,
          resolutionArtifactId: metadata.resolution.artifact_id,
          acceptedDebtIds: metadata.resolution.acceptedDebtIds,
          verdict,
        }
      : {}),
  };
  const facts: CheckpointChange<JudgmentApplied>["facts"] = [
    ...humanResolutionFacts(closure),
    { type: "artifact.registered", data: { ...summary, artifactId: summary.artifact_id } },
    {
      type: "judgment.applied",
      data: { ...references, verdict: closure.verdict, incrementIds: closure.incrementIds },
    },
  ];
  if (closure.verdict !== "REJECT")
    for (const incrementId of closure.incrementIds) {
      const review = checkpoint.verifications[incrementId]?.findLast(
        (state) => state.planArtifactId === closure.planArtifactId,
      );
      if (
        !review ||
        review.lifecycle.status !== "completed" ||
        review.lifecycle.verdict !== "verified"
      )
        invalid("acceptance requires verified increment evidence");
      facts.push({
        type: "increment.accepted",
        data: {
          ...references,
          incrementId,
          implementationArtifactId: review.implementation.artifactId,
          verificationArtifactId: review.lifecycle.artifactId,
        },
      });
    }
  facts.push({
    type: "run.finished",
    data: {
      ...references,
      status: closure.status,
      summaryArtifactId: summary.artifact_id,
      summaryPath: summary.path,
    },
  });
  return {
    state: { ...structuredClone(checkpoint), closure },
    facts,
    result: { ...structuredClone(closure), runId: context.runId, replayed: false },
    definition: judgmentDefinition,
    context,
  };
}
