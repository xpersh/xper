import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { closeRun } from "../delivery/closure.js";
import { reopenJudgment } from "../delivery/judgment-feedback.js";
import { closureSummary } from "../delivery/summary.js";
import { prepareResolution } from "./resolution.js";
import type { JudgmentResolutionInput } from "../types.js";
import { invalid, object } from "../validation.js";
import { readRegisteredArtifact } from "./evidence.js";
import { checkEvaluation } from "./judgment.js";
import type { ArtifactWriter, WorkflowEffects } from "./ports.js";

export async function prepareClosure(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  revision: string,
  effects: WorkflowEffects & { writeArtifact: ArtifactWriter },
  input?: JudgmentResolutionInput,
) {
  const judgment = checkpoint.judgment;
  if (!judgment?.report) invalid("Judge report is required");
  const { report, resolution, metadata } = await prepareResolution(
    checkpoint,
    reportId,
    input,
    effects,
  );
  const verdict = resolution?.decision ?? report.output.verdict;
  if (verdict !== "ACCEPT" && verdict !== "ACCEPT_WITH_DEBT" && verdict !== "REJECT") {
    const now = effects.now();
    return {
      now,
      change: reopenJudgment(checkpoint, report, effects.id(), now, resolution, metadata),
    };
  }
  const path = `.xper/artifacts/run-summary-${reportId}.md`;
  const content = closureSummary(
    checkpoint.knowledge.run_id,
    reportId,
    judgment.report.path,
    report,
    resolution,
  );
  try {
    if ((await effects.writeArtifact(reportId, content, path)) !== path)
      invalid("unexpected summary path");
  } catch (error) {
    if (!object(error) || error.code !== "EEXIST") throw error;
    // A previous interrupted application may have saved this deterministic file.
  }
  const summary = await effects.readArtifact(path);
  if (summary.content !== content)
    invalid("existing run summary differs; preserve it before retrying");
  await readRegisteredArtifact(checkpoint, effects.readArtifact, reportId);
  await checkEvaluation(judgment.evaluation, effects);
  if (
    metadata.resolution &&
    (await effects.readArtifact(metadata.resolution.path)).digest !== metadata.resolution.digest
  )
    invalid("human resolution changed before application");
  const now = effects.now();
  return {
    now,
    change: closeRun(
      checkpoint,
      reportId,
      revision,
      {
        artifact_id: `run-summary-${reportId}`,
        kind: "run_summary",
        version: 1,
        path,
        digest: summary.digest,
      },
      now,
      resolution,
      metadata,
    ),
  };
}
