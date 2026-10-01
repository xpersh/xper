import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { closeRun } from "../delivery/closure.js";
import { closureSummary } from "../delivery/summary.js";
import { parseJudgmentReport } from "../judgment/contract.js";
import { invalid, object } from "../validation.js";
import { readRegisteredArtifact } from "./evidence.js";
import { checkEvaluation } from "./judgment.js";
import type { ArtifactWriter, WorkflowEffects } from "./ports.js";

export async function prepareClosure(
  checkpoint: AdapterCheckpoint,
  reportId: string,
  revision: string,
  effects: WorkflowEffects & { writeArtifact: ArtifactWriter },
) {
  const judgment = checkpoint.judgment;
  if (!judgment?.report) invalid("Judge report is required");
  const evidence = await readRegisteredArtifact(checkpoint, effects.readArtifact, reportId);
  const report = parseJudgmentReport(evidence.content, judgment.evaluation, judgment.assignmentId);
  if (report.output.verdict !== judgment.report.verdict)
    invalid("Judge verdict does not match registration");
  await checkEvaluation(judgment.evaluation, effects);
  const path = `.xper/artifacts/run-summary-${reportId}.md`;
  const content = closureSummary(
    checkpoint.knowledge.run_id,
    reportId,
    judgment.report.path,
    report,
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
    ),
  };
}
