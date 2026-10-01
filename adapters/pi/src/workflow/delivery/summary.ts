import type { JudgmentReport } from "../judgment/contract.js";

/** A bounded excerpt preserves the original as the authoritative linked evidence. */
const excerpt = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .slice(0, 320)
    .replace(/[\\`*_{}\[\]<>()|#!]/g, "\\$&") + (text.replace(/\s+/g, " ").length > 320 ? "…" : "");

export function closureSummary(
  runId: string,
  reportId: string,
  reportPath: string,
  report: JudgmentReport,
): string {
  const { evaluation, output } = report;
  const link = (id: string) => {
    const artifact = evaluation.artifacts.find((item) => item.artifact_id === id);
    return artifact ? `[${excerpt(id)}](${artifact.path.split("/").at(-1)})` : `\`${id}\``;
  };
  const definition = evaluation.artifacts.find(
    (artifact) => artifact.kind === "definition_contract",
  );
  const design = evaluation.artifacts.find((artifact) => artifact.kind === "design_decisions");
  return [
    "# Run summary",
    "",
    `Run: ${excerpt(runId)}. Result: **${output.verdict === "ACCEPT" ? "accepted" : "rejected"}**.`,
    "",
    `Judge report: [${excerpt(reportId)}](${reportPath.split("/").at(-1)}).`,
    "",
    excerpt(output.reason),
    "",
    `Plan: ${link(evaluation.planArtifactId)}. Increments: ${evaluation.incrementIds.map(excerpt).join(", ")}.`,
    "",
    `Base: \`${evaluation.baseCommit}\`. Evaluated commit: \`${evaluation.evaluatedCommit}\`.`,
    "",
    `Diff: \`git:${evaluation.baseCommit}..${evaluation.evaluatedCommit}\`.`,
    "",
    "## Criteria",
    "",
    "| Criterion | Outcome | Finding and evidence |",
    "| --- | --- | --- |",
    ...output.criteria.map(
      (item) =>
        `| ${definition ? `[${excerpt(item.criterionId)}](${definition.path.split("/").at(-1)})` : excerpt(item.criterionId)} | ${item.outcome} | ${excerpt(item.reason)} ${item.evidence.map(link).join(", ")} |`,
    ),
    "",
    "## Decisions and evidence",
    "",
    ...(design ? [`Design decisions: ${link(design.artifact_id)}.`, ""] : []),
    ...evaluation.artifacts.map(
      (artifact) => `- ${excerpt(artifact.kind)}: ${link(artifact.artifact_id)}`,
    ),
    ...evaluation.logs.map(
      (log) => `- Test log: [${log.path.split("/").at(-1)}](${log.path.split("/").at(-1)})`,
    ),
    "",
    "## Unresolved findings",
    "",
    ...output.criteria
      .filter((item) => item.outcome !== "passed")
      .map(
        (item) =>
          `- ${excerpt(item.criterionId)} (${item.outcome}): ${excerpt(item.reason)} ${item.evidence.map(link).join(", ")}`,
      ),
    ...output.criticisms.map(
      (item) => `- ${excerpt(item.reason)} ${item.evidence.map(link).join(", ")}`,
    ),
    ...(output.criteria.every((item) => item.outcome === "passed") && !output.criticisms.length
      ? ["No unresolved findings reported by Judge."]
      : []),
    "",
    "Findings are excerpts; the linked artifacts retain the complete evidence.",
    "",
  ].join("\n");
}
