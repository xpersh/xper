import type { JudgmentReport } from "../workflow/judgment/contract.js";
import type {
  JudgmentApproval,
  JudgmentDecision,
  JudgmentResolutionInput,
} from "../workflow/types.js";
import type { PiContext } from "./types.js";

/** Only the command's human dialog constructs a resolution; delegation never calls this. */
export async function promptJudgmentResolution(
  ctx: PiContext,
  approval: Exclude<JudgmentApproval, { applied: unknown }>,
): Promise<JudgmentResolutionInput | undefined> {
  if (!ctx.hasUI) return undefined;
  const report = JSON.parse(approval.content) as JudgmentReport;
  ctx.ui.notify(
    [
      `Judge report ${approval.reportId} (${approval.reportPath})`,
      `Evaluated commit: ${approval.evaluation.evaluatedCommit}. Recommendation: ${approval.recommendation}.`,
      report.output.reason,
      ...report.output.criteria.map(
        (item) =>
          `${item.criterionId}: ${item.outcome}. ${item.reason} Evidence: ${item.evidence.join(", ")}`,
      ),
      ...report.output.criticisms.map(
        (item) => `${item.reason} Evidence: ${item.evidence.join(", ")}`,
      ),
      ...approval.evaluation.artifacts.map((item) => `${item.artifact_id}: ${item.path}`),
      ...describeDetails(approval.debts ?? [], approval.humanDecision),
    ].join("\n"),
    "info",
  );
  const ask = async (title: string) => (await ctx.ui.input(title))?.trim() || undefined;
  let input: JudgmentResolutionInput;
  if (approval.savedResolution) {
    const saved = approval.savedResolution;
    input = {
      decision: saved.decision,
      reason: saved.reason,
      debts: saved.debts,
      ...(saved.humanDecision ? { humanDecision: saved.humanDecision } : {}),
    };
  } else {
    const hasDebt = approval.recommendation === "ACCEPT_WITH_DEBT" || !!approval.debts?.length;
    const choices = [
      hasDebt ? "ACCEPT_WITH_DEBT" : "ACCEPT",
      "REJECT",
      "REWORK_IMPLEMENTATION",
      "REVISIT_DESIGN",
      "REDEFINE",
    ];
    const decision = await ask(`Choose a decision: ${choices.join(", ")}`);
    if (!decision || !choices.includes(decision)) return undefined;
    const debts = structuredClone(approval.debts ?? []);
    if (decision === "ACCEPT_WITH_DEBT" && !debts.length) {
      const countText = await ask("Legacy report: how many debts are being accepted together?");
      const count = Number(countText);
      if (!countText || !Number.isSafeInteger(count) || count < 1) return undefined;
      for (let index = 1; index <= count; index++) {
        const description = await ask(`Debt ${index}: description`);
        if (!description) return undefined;
        const owner = await ask(`Debt ${index}: logical owner`);
        if (!owner) return undefined;
        const futureCondition = await ask(`Debt ${index}: future condition for addressing it`);
        if (!futureCondition) return undefined;
        debts.push({ id: `debt-${index}`, description, owner, futureCondition });
      }
    }
    let humanDecision = approval.humanDecision;
    if (approval.recommendation === "HUMAN_DECISION" && !humanDecision) {
      const question = await ask("Legacy report: state the question you are resolving");
      if (!question) return undefined;
      const sources = [
        ...approval.evaluation.artifacts.map((item) => item.artifact_id),
        `git:${approval.evaluation.baseCommit}..${approval.evaluation.evaluatedCommit}`,
      ];
      const references = await ask(
        `Question evidence: comma-separated references from ${sources.join(", ")}`,
      );
      if (!references) return undefined;
      const evidence = references.split(",").map((item) => item.trim());
      if (
        new Set(evidence).size !== evidence.length ||
        evidence.some((id) => !sources.includes(id))
      )
        return undefined;
      humanDecision = { question, evidence };
    }
    const reason = await ask("Explain your decision");
    if (!reason) return undefined;
    input = {
      decision: decision as JudgmentDecision,
      reason,
      debts,
      ...(humanDecision ? { humanDecision } : {}),
    };
  }
  ctx.ui.notify(
    [
      `Human resolution for ${approval.reportId} at ${approval.evaluation.evaluatedCommit}`,
      `Decision: ${input.decision}. Reason: ${input.reason}`,
      ...describeDetails(input.debts, input.humanDecision),
      ...(input.decision === "ACCEPT_WITH_DEBT"
        ? ["Acceptance confirms every debt listed above."]
        : []),
    ].join("\n"),
    "info",
  );
  return (await ask("Type CONFIRM to record and apply this exact resolution")) === "CONFIRM"
    ? input
    : undefined;
}

function describeDetails(
  debts: JudgmentResolutionInput["debts"],
  question: JudgmentResolutionInput["humanDecision"],
): string[] {
  return [
    ...(question
      ? [`Question: ${question.question}`, `Evidence: ${question.evidence.join(", ")}`]
      : []),
    ...debts.map(
      (debt) =>
        `${debt.id}: ${debt.description}. Owner: ${debt.owner}. Future condition: ${debt.futureCondition}.`,
    ),
  ];
}
