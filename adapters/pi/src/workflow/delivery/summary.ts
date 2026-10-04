import type { JudgmentResolution } from "../types.js";
import type { JudgmentReport } from "../judgment/contract.js";

const literal = (text: string) =>
  text.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]<>()|#!]/g, "\\$&");

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
  resolution?: JudgmentResolution,
): string {
  const { evaluation, output } = report;
  const verdict = resolution?.decision ?? output.verdict;
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
    `Run: ${excerpt(runId)}. Result: **${verdict === "ACCEPT" ? "accepted" : verdict === "ACCEPT_WITH_DEBT" ? "accepted_with_debt" : "rejected"}**.`,
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
    ...(resolution
      ? [
          "## Human resolution",
          "",
          `Recommendation: ${output.verdict}. Decision: ${resolution.decision}.`,
          "",
          `[Recorded human resolution](judgment-resolution-${reportId}.json)`,
          "",
          literal(resolution.reason),
          "",
          ...(resolution.humanDecision
            ? [
                `Question: ${literal(resolution.humanDecision.question)}`,
                "",
                ...resolution.humanDecision.evidence.map(link),
                "",
              ]
            : []),
          "## Debt",
          "",
          ...resolution.debts.map(
            (debt) =>
              `- ${literal(debt.id)}: ${literal(debt.description)} — Owner: ${literal(debt.owner)}. Future condition: ${literal(debt.futureCondition)}.`,
          ),
          "",
        ]
      : []),
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
