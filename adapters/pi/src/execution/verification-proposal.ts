import type { VerificationExecution } from "../actions/execution.js";

export type Outcome = "passed" | "failed";

export interface Finding {
  outcome: Outcome;
  evidence: string;
  paths: string[];
}

export interface Proposal {
  schemaVersion: 1;
  verdict: "verified" | "rejected";
  testCommands: string[];
  criteria: Array<Finding & { criterionId: string }>;
  review: { regressions: Finding; scope: Finding; simplicity: Finding };
  rejection: null | {
    cause: string;
    evidence: string;
    paths: string[];
    knowledgeFeedback?: { reason: "ambiguous_criteria" | "infeasible_design" } | null;
  };
}

export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const relativePath = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.split(/[\\/]/).includes("..");

export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function finding(value: unknown): Finding {
  if (
    !object(value) ||
    !exactKeys(value, ["outcome", "evidence", "paths"]) ||
    !["passed", "failed"].includes(String(value.outcome)) ||
    !text(value.evidence) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(relativePath)
  )
    throw new Error("Verifier report has invalid evidence");
  return value as unknown as Finding;
}

export function parseProposal(
  content: string,
  criteria: NonNullable<VerificationExecution["criteria"]>,
): Proposal {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Verifier must return the required JSON report");
  }
  if (
    !object(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "verdict",
      "testCommands",
      "criteria",
      "review",
      "rejection",
    ]) ||
    value.schemaVersion !== 1 ||
    !["verified", "rejected"].includes(String(value.verdict)) ||
    !Array.isArray(value.testCommands) ||
    value.testCommands.length > 16 ||
    !value.testCommands.every((command) => text(command) && command.length <= 4_096) ||
    new Set(value.testCommands).size !== value.testCommands.length ||
    !Array.isArray(value.criteria) ||
    !object(value.review) ||
    !exactKeys(value.review, ["regressions", "scope", "simplicity"])
  )
    throw new Error("Verifier report has an unsupported shape");
  const expected = new Set(criteria.map((criterion) => criterion.id));
  const actual = new Set<string>();
  const criterionFindings = value.criteria.map((item) => {
    if (
      !object(item) ||
      !exactKeys(item, ["criterionId", "outcome", "evidence", "paths"]) ||
      !text(item.criterionId) ||
      actual.has(item.criterionId)
    )
      throw new Error("Verifier report has invalid criterion evidence");
    actual.add(item.criterionId);
    return {
      criterionId: item.criterionId,
      ...finding({ outcome: item.outcome, evidence: item.evidence, paths: item.paths }),
    };
  });
  if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id)))
    throw new Error("Verifier report must cover every selected criterion exactly once");
  const review = {
    regressions: finding(value.review.regressions),
    scope: finding(value.review.scope),
    simplicity: finding(value.review.simplicity),
  };
  const rejection = value.rejection;
  if (
    rejection !== null &&
    (!object(rejection) ||
      (!exactKeys(rejection, ["cause", "evidence", "paths"]) &&
        !exactKeys(rejection, ["cause", "evidence", "paths", "knowledgeFeedback"])) ||
      !text(rejection.cause) ||
      !text(rejection.evidence) ||
      !Array.isArray(rejection.paths) ||
      !rejection.paths.every(relativePath) ||
      (rejection.knowledgeFeedback !== undefined &&
        rejection.knowledgeFeedback !== null &&
        (!object(rejection.knowledgeFeedback) ||
          !exactKeys(rejection.knowledgeFeedback, ["reason"]) ||
          !["ambiguous_criteria", "infeasible_design"].includes(
            String(rejection.knowledgeFeedback.reason),
          ))))
  )
    throw new Error("Verifier rejection needs a cause and evidence");
  const failed = [
    ...criterionFindings.map((item) => item.outcome),
    review.regressions.outcome,
    review.scope.outcome,
    review.simplicity.outcome,
  ].includes("failed");
  if (
    (value.verdict === "verified" && (failed || rejection !== null)) ||
    (value.verdict === "rejected" && (!failed || rejection === null))
  )
    throw new Error("Verifier verdict is inconsistent with its evidence");
  return {
    schemaVersion: 1,
    verdict: value.verdict as Proposal["verdict"],
    testCommands: value.testCommands as string[],
    criteria: criterionFindings,
    review,
    rejection:
      rejection === null
        ? null
        : ({
            cause: rejection.cause,
            evidence: rejection.evidence,
            paths: rejection.paths,
            knowledgeFeedback: rejection.knowledgeFeedback ?? null,
          } as Proposal["rejection"]),
  };
}
