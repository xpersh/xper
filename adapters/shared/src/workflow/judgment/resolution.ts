import { keys, text } from "../contract-validation.js";
import type {
  HumanResolutionMetadata,
  JudgmentResolution,
  JudgmentResolutionInput,
  JudgmentApplied,
} from "../types.js";
import { invalid, object } from "../validation.js";
import {
  type JudgmentReport,
  type Verdict,
  validateResolutionDetails,
  verdicts,
} from "./contract.js";

export const needsResolution = (verdict: string) =>
  verdict === "ACCEPT_WITH_DEBT" || verdict === "HUMAN_DECISION";
export const resolutionPath = (reportId: string) =>
  `.xper/artifacts/judgment-resolution-${reportId}.json`;

export function resolutionInput(report: JudgmentReport, value: unknown): JudgmentResolutionInput {
  if (
    !object(value) ||
    !keys(value, [
      "decision",
      "reason",
      "debts",
      ...("humanDecision" in value ? ["humanDecision"] : []),
    ]) ||
    !verdicts.includes(value.decision as Verdict) ||
    value.decision === "HUMAN_DECISION" ||
    !text(value.reason) ||
    !Array.isArray(value.debts)
  )
    invalid("a complete human resolution is required; recommendation remains pending");
  validateResolutionDetails(
    value.debts.length ? value.debts : undefined,
    value.humanDecision,
    report.evaluation,
  );
  const output = report.output;
  if (
    !needsResolution(output.verdict) ||
    (output.debts && JSON.stringify(value.debts) !== JSON.stringify(output.debts)) ||
    (output.humanDecision &&
      JSON.stringify(value.humanDecision) !== JSON.stringify(output.humanDecision)) ||
    (output.verdict === "HUMAN_DECISION" && !value.humanDecision) ||
    (value.decision === "ACCEPT_WITH_DEBT" && !value.debts.length) ||
    (value.decision === "ACCEPT" && (value.debts.length || output.verdict === "ACCEPT_WITH_DEBT"))
  )
    invalid("human resolution must preserve the question and accept all debt explicitly");
  return {
    decision: value.decision as JudgmentResolutionInput["decision"],
    reason: value.reason.trim(),
    debts: structuredClone(value.debts) as JudgmentResolutionInput["debts"],
    ...(value.humanDecision
      ? {
          humanDecision: structuredClone(value.humanDecision) as NonNullable<
            JudgmentResolutionInput["humanDecision"]
          >,
        }
      : {}),
  };
}

export function createResolution(
  reportId: string,
  reportDigest: string,
  report: JudgmentReport,
  input: unknown,
  confirmedAt: number,
): JudgmentResolution {
  const resolution = resolutionInput(report, input);
  if (!Number.isSafeInteger(confirmedAt) || confirmedAt < 0)
    invalid("invalid human confirmation time");
  return {
    schemaVersion: 1,
    reportId,
    reportDigest,
    planArtifactId: report.evaluation.planArtifactId,
    evaluatedCommit: report.evaluation.evaluatedCommit,
    recommendation: report.output.verdict as JudgmentResolution["recommendation"],
    ...resolution,
    confirmedAt,
    completedByHuman: [
      ...(!report.output.debts && resolution.debts.length ? ["debts" as const] : []),
      ...(!report.output.humanDecision && resolution.humanDecision
        ? ["humanDecision" as const]
        : []),
    ],
  };
}

export function parseResolution(
  content: string,
  reportId: string,
  digest: string,
  report: JudgmentReport,
): JudgmentResolution {
  const value: unknown = JSON.parse(content);
  if (!object(value)) invalid("invalid saved human resolution");
  const input = {
    decision: value.decision,
    reason: value.reason,
    debts: value.debts,
    ...(value.humanDecision ? { humanDecision: value.humanDecision } : {}),
  };
  const expected = createResolution(reportId, digest, report, input, Number(value.confirmedAt));
  if (
    !keys(value, Object.keys(expected)) ||
    Object.entries(expected).some(
      ([key, item]) => JSON.stringify(value[key]) !== JSON.stringify(item),
    )
  )
    invalid("saved resolution does not match the exact report");
  return expected;
}

export function resolutionMetadata(
  resolution: JudgmentResolution,
  digest: string,
): HumanResolutionMetadata {
  return {
    recommendation: resolution.recommendation,
    resolution: {
      artifact_id: `judgment-resolution-${resolution.reportId}`,
      kind: "judgment_resolution",
      version: 1,
      path: resolutionPath(resolution.reportId),
      digest,
      confirmedAt: resolution.confirmedAt,
      decision: resolution.decision,
      acceptedDebtIds:
        resolution.decision === "ACCEPT_WITH_DEBT" ? resolution.debts.map((item) => item.id) : [],
    },
  };
}

export function validateResolutionMetadata(
  value: Record<string, unknown>,
  recommendation: string,
  reportId: string,
  appliedAt: number,
): void {
  if (!needsResolution(recommendation)) {
    if (
      value.verdict !== recommendation ||
      value.resolution !== undefined ||
      value.recommendation !== undefined
    )
      invalid("unexpected human resolution metadata");
    return;
  }
  const ref = value.resolution;
  if (
    value.recommendation !== recommendation ||
    !object(ref) ||
    ref.kind !== "judgment_resolution" ||
    ref.version !== 1 ||
    ref.decision !== value.verdict ||
    ref.artifact_id !== `judgment-resolution-${reportId}` ||
    ref.path !== resolutionPath(reportId) ||
    typeof ref.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.confirmedAt) ||
    Number(ref.confirmedAt) < 0 ||
    Number(ref.confirmedAt) > appliedAt ||
    !Array.isArray(ref.acceptedDebtIds) ||
    !ref.acceptedDebtIds.every(text) ||
    new Set(ref.acceptedDebtIds).size !== ref.acceptedDebtIds.length ||
    (value.verdict === "ACCEPT_WITH_DEBT") !== ref.acceptedDebtIds.length > 0 ||
    (recommendation === "ACCEPT_WITH_DEBT" && value.verdict === "ACCEPT")
  )
    invalid("invalid human resolution metadata");
}

export function humanResolutionFacts(
  decision: Omit<JudgmentApplied, "runId" | "replayed">,
): Array<{ type: string; data: Record<string, unknown> }> {
  const resolution = decision.resolution;
  if (!resolution) return [];
  return [
    { type: "artifact.registered", data: { ...resolution, artifactId: resolution.artifact_id } },
    {
      type: "judgment.resolved",
      data: {
        reportId: decision.reportId,
        reportDigest: decision.reportDigest,
        planArtifactId: decision.planArtifactId,
        evaluatedCommit: decision.evaluatedCommit,
        recommendation: decision.recommendation,
        verdict: decision.verdict,
        resolutionArtifactId: resolution.artifact_id,
        acceptedDebtIds: resolution.acceptedDebtIds,
      },
    },
  ];
}
