import { keys, text } from "../contract-validation.js";
import type { JudgmentDebt, HumanQuestion, JudgmentEvaluation } from "../types.js";
import { invalid, object } from "../validation.js";

export const verdicts = [
  "ACCEPT",
  "ACCEPT_WITH_DEBT",
  "REWORK_IMPLEMENTATION",
  "REVISIT_DESIGN",
  "REDEFINE",
  "HUMAN_DECISION",
  "REJECT",
] as const;
export type Verdict = (typeof verdicts)[number];
export interface Finding {
  reason: string;
  evidence: string[];
}
export interface JudgmentProposal {
  debts?: JudgmentDebt[];
  humanDecision?: HumanQuestion;
  verdict: Verdict;
  reason: string;
  criteria: Array<Finding & { criterionId: string; outcome: "passed" | "failed" | "uncertain" }>;
  criticisms: Finding[];
}
export interface JudgmentReport {
  schemaVersion: 1;
  evaluation: JudgmentEvaluation;
  output: JudgmentProposal & { kind: "judgment_verdict"; assignmentId: string };
}
export const diffReference = (evaluation: JudgmentEvaluation) =>
  `git:${evaluation.baseCommit}..${evaluation.evaluatedCommit}`;

export function parseJudgmentReport(
  content: string,
  evaluation: JudgmentEvaluation,
  assignmentId: string,
  requireDetails = false,
): JudgmentReport {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("Judge report must be JSON");
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !keys(value, ["schemaVersion", "evaluation", "output"]) ||
    JSON.stringify(value.evaluation) !== JSON.stringify(evaluation) ||
    !object(value.output)
  )
    invalid("Judge report does not match frozen evaluation");
  const output = value.output;
  const sources = new Set([
    ...evaluation.artifacts.map((artifact) => artifact.artifact_id),
    diffReference(evaluation),
  ]);
  const finding = (item: unknown) =>
    object(item) &&
    typeof item.reason === "string" &&
    item.reason.trim().length > 0 &&
    Array.isArray(item.evidence) &&
    item.evidence.length > 0 &&
    new Set(item.evidence).size === item.evidence.length &&
    item.evidence.every((id) => typeof id === "string" && sources.has(id));
  if (
    output.kind !== "judgment_verdict" ||
    !keys(output, [
      "kind",
      "assignmentId",
      "verdict",
      "reason",
      "criteria",
      "criticisms",
      ...("debts" in output ? ["debts"] : []),
      ...("humanDecision" in output ? ["humanDecision"] : []),
    ]) ||
    output.assignmentId !== assignmentId ||
    !verdicts.includes(output.verdict as Verdict) ||
    typeof output.reason !== "string" ||
    !output.reason.trim() ||
    !Array.isArray(output.criteria) ||
    output.criteria.length !== evaluation.criterionIds.length ||
    new Set(output.criteria.map((item) => (object(item) ? item.criterionId : null))).size !==
      evaluation.criterionIds.length ||
    !output.criteria.every(
      (item) =>
        finding(item) &&
        object(item) &&
        keys(item, ["criterionId", "outcome", "reason", "evidence"]) &&
        text(item.criterionId) &&
        evaluation.criterionIds.includes(item.criterionId) &&
        ["passed", "failed", "uncertain"].includes(String(item.outcome)),
    ) ||
    !Array.isArray(output.criticisms) ||
    !output.criticisms.every(
      (item) => finding(item) && object(item) && keys(item, ["reason", "evidence"]),
    )
  )
    invalid("Judge report requires every criterion and exact evidence references");
  validateResolutionDetails(output.debts, output.humanDecision, evaluation);
  if (
    requireDetails &&
    ((output.verdict === "ACCEPT_WITH_DEBT" && !output.debts) ||
      (output.verdict === "HUMAN_DECISION" && !output.humanDecision))
  )
    invalid("new Judge reports require structured debt or a human question");
  if (
    (output.debts !== undefined || output.humanDecision !== undefined) &&
    !["ACCEPT_WITH_DEBT", "HUMAN_DECISION"].includes(String(output.verdict))
  )
    invalid("resolution details require a debt or human recommendation");
  return value as unknown as JudgmentReport;
}

export function validateResolutionDetails(
  debts: unknown,
  question: unknown,
  evaluation: JudgmentEvaluation,
): void {
  if (
    debts !== undefined &&
    (!Array.isArray(debts) ||
      !debts.length ||
      !debts.every(
        (item) =>
          object(item) &&
          keys(item, ["id", "description", "owner", "futureCondition"]) &&
          [item.id, item.description, item.owner, item.futureCondition].every(text),
      ) ||
      new Set(debts.map((item) => item.id)).size !== debts.length)
  )
    invalid("invalid debt details");
  const sources = new Set([
    ...evaluation.artifacts.map((item) => item.artifact_id),
    diffReference(evaluation),
  ]);
  if (
    question !== undefined &&
    (!object(question) ||
      !keys(question, ["question", "evidence"]) ||
      !text(question.question) ||
      !Array.isArray(question.evidence) ||
      !question.evidence.length ||
      new Set(question.evidence).size !== question.evidence.length ||
      !question.evidence.every((id) => typeof id === "string" && sources.has(id)))
  )
    invalid("invalid human question or evidence");
}
