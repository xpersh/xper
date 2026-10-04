import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { parseJudgmentReport } from "../judgment/contract.js";
import {
  createResolution,
  needsResolution,
  parseResolution,
  resolutionInput,
  resolutionMetadata,
  resolutionPath,
} from "../judgment/resolution.js";
import type {
  HumanResolutionMetadata,
  JudgmentApplied,
  JudgmentResolution,
  JudgmentResolutionInput,
  RunClosure,
  JudgmentReopened,
} from "../types.js";
import { invalid, object } from "../validation.js";
import { readRegisteredArtifact } from "./evidence.js";
import { checkEvaluation } from "./judgment.js";
import type { ArtifactWriter, WorkflowEffects } from "./ports.js";

export async function approvalContext(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  effects: WorkflowEffects,
) {
  const judgment = checkpoint.judgment;
  if (!judgment?.report) invalid("Judge report is required");
  const evidence = await readRegisteredArtifact(checkpoint, effects.readArtifact, reportId);
  const report = parseJudgmentReport(evidence.content, judgment.evaluation, judgment.assignmentId);
  if (report.output.verdict !== judgment.report.verdict)
    invalid("Judge verdict does not match registration");
  await checkEvaluation(judgment.evaluation, effects);
  let savedResolution: JudgmentResolution | undefined;
  if (needsResolution(report.output.verdict)) {
    let saved: { content: string } | undefined;
    try {
      saved = await effects.readArtifact(resolutionPath(reportId));
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
    }
    if (saved) savedResolution = parseResolution(saved.content, reportId, evidence.digest, report);
  }
  return {
    report,
    context: {
      reportId,
      reportDigest: evidence.digest,
      reportPath: judgment.report.path,
      content: evidence.content,
      evaluation: judgment.evaluation,
      recommendation: report.output.verdict,
      ...(report.output.debts ? { debts: report.output.debts } : {}),
      ...(report.output.humanDecision ? { humanDecision: report.output.humanDecision } : {}),
      ...(savedResolution ? { savedResolution } : {}),
    },
  };
}

export async function prepareResolution(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  input: JudgmentResolutionInput | undefined,
  effects: WorkflowEffects & { writeArtifact: ArtifactWriter },
) {
  const { report, context } = await approvalContext(checkpoint, reportId, effects);
  if (!needsResolution(report.output.verdict)) {
    if (input) invalid("this recommendation does not require a human resolution");
    return { report, metadata: {} as HumanResolutionMetadata };
  }
  const saved = context.savedResolution;
  if (
    saved &&
    input &&
    JSON.stringify(resolutionInput(report, input)) !==
      JSON.stringify(
        resolutionInput(report, {
          decision: saved.decision,
          reason: saved.reason,
          debts: saved.debts,
          ...(saved.humanDecision ? { humanDecision: saved.humanDecision } : {}),
        }),
      )
  )
    invalid("conflicting human resolution; the saved decision cannot be replaced");
  const resolution =
    saved ?? createResolution(reportId, context.reportDigest, report, input, effects.now());
  const path = resolutionPath(reportId);
  const content = JSON.stringify(resolution);
  if (!saved) {
    try {
      if ((await effects.writeArtifact(reportId, content, path)) !== path)
        invalid("unexpected resolution path");
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") throw error;
    }
  }
  const evidence = await effects.readArtifact(path);
  if (evidence.content !== content) invalid("conflicting saved human resolution");
  await readRegisteredArtifact(checkpoint, effects.readArtifact, reportId);
  await checkEvaluation(report.evaluation, effects);
  return { report, resolution, metadata: resolutionMetadata(resolution, evidence.digest) };
}

export async function checkResolutionReplay(
  checkpoint: AdapterCheckpoint,
  result: JudgmentApplied,
  input: JudgmentResolutionInput | undefined,
  effects: WorkflowEffects,
) {
  if (!result.resolution) {
    if (input) invalid("conflicting human resolution for an existing decision");
    return;
  }
  const saved = await readAppliedResolution(checkpoint, result, effects);
  if (!input) return;
  const expected = {
    decision: saved.decision,
    reason: saved.reason,
    debts: saved.debts,
    ...(saved.humanDecision ? { humanDecision: saved.humanDecision } : {}),
  };
  if (
    Object.keys(input).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, value]) =>
        JSON.stringify(input[key as keyof JudgmentResolutionInput]) !== JSON.stringify(value),
    )
  )
    invalid("conflicting human resolution for an existing decision");
}

export async function readAppliedResolution(
  checkpoint: AdapterCheckpoint,
  decision: RunClosure | JudgmentReopened,
  effects: Pick<WorkflowEffects, "readArtifact">,
): Promise<JudgmentResolution> {
  const reference = decision.resolution;
  if (!reference) invalid("human resolution reference is required");
  const evidence = await readRegisteredArtifact(
    checkpoint,
    effects.readArtifact,
    reference.artifact_id,
  );
  const saved = JSON.parse(evidence.content) as JudgmentResolution;
  if (
    saved.reportId !== decision.reportId ||
    saved.reportDigest !== decision.reportDigest ||
    saved.planArtifactId !== decision.planArtifactId ||
    saved.evaluatedCommit !== decision.evaluatedCommit ||
    saved.recommendation !== decision.recommendation ||
    saved.decision !== decision.verdict ||
    saved.confirmedAt !== reference.confirmedAt ||
    JSON.stringify(reference.acceptedDebtIds) !==
      JSON.stringify(
        saved.decision === "ACCEPT_WITH_DEBT" ? saved.debts.map((debt) => debt.id) : [],
      )
  )
    invalid("human resolution does not match the recorded decision");
  return saved;
}
