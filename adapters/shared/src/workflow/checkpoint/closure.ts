import { validateResolutionMetadata } from "../judgment/resolution.js";
import type { RunClosure } from "../types.js";
import { invalid, object } from "../validation.js";
import type { AdapterCheckpoint } from "./types.js";

export function decodeClosure(value: unknown, checkpoint: AdapterCheckpoint): RunClosure | null {
  if (value === null) return null;
  const judgment = checkpoint.judgment;
  const report = judgment?.report;
  if (
    !object(value) ||
    !judgment ||
    !report ||
    value.reportId !== report.artifact_id ||
    value.reportDigest !== report.digest ||
    value.planArtifactId !== judgment.evaluation.planArtifactId ||
    value.evaluatedCommit !== judgment.evaluation.evaluatedCommit ||
    !["ACCEPT", "ACCEPT_WITH_DEBT", "REJECT"].includes(String(value.verdict)) ||
    value.status !==
      (value.verdict === "ACCEPT"
        ? "accepted"
        : value.verdict === "ACCEPT_WITH_DEBT"
          ? "accepted_with_debt"
          : "rejected") ||
    JSON.stringify(value.incrementIds) !== JSON.stringify(judgment.evaluation.incrementIds) ||
    !Number.isSafeInteger(value.closedAt) ||
    Number(value.closedAt) < checkpoint.knowledge.startedAt ||
    Object.values(judgment.attempts).some(
      (attempt) => attempt.startedAt > Number(value.closedAt),
    ) ||
    !object(value.summary) ||
    value.summary.artifact_id !== `run-summary-${report.artifact_id}` ||
    value.summary.kind !== "run_summary" ||
    value.summary.version !== 1 ||
    value.summary.path !== `.xper/artifacts/run-summary-${report.artifact_id}.md` ||
    !/^[a-zA-Z0-9-]+$/.test(report.artifact_id) ||
    typeof value.summary.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.summary.digest)
  )
    invalid("invalid run closure checkpoint");
  validateResolutionMetadata(value, report.verdict, report.artifact_id, Number(value.closedAt));
  if (
    object(value.resolution) &&
    Object.values(judgment.attempts).some(
      (attempt) =>
        attempt.startedAt > Number((value.resolution as Record<string, unknown>).confirmedAt),
    )
  )
    invalid("human resolution predates Judgment");
  const summaryId = value.summary.artifact_id;
  if (
    [
      checkpoint.knowledge,
      ...Object.values(checkpoint.implementations).flat(),
      ...Object.values(checkpoint.verifications).flat(),
    ].some(
      (owner) =>
        Object.hasOwn(owner.artifacts, summaryId) ||
        (object(value.resolution) &&
          Object.hasOwn(owner.artifacts, String(value.resolution.artifact_id))),
    )
  )
    invalid("duplicate closure summary identity");
  return structuredClone(value) as unknown as RunClosure;
}
