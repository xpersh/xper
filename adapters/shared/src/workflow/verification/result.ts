import { invalid, object } from "../validation.js";
import type { VerificationFinding, VerificationResult } from "./contract.js";
import type { VerificationState } from "./state.js";
import {
  artifactPath,
  exactKeys,
  integer,
  knowledgeFeedbackReason,
  relativePath,
  strings,
  text,
} from "./validation.js";

export function parseFinding(value: unknown): VerificationFinding {
  if (
    !object(value) ||
    !exactKeys(value, ["outcome", "evidence", "paths"]) ||
    !["passed", "failed"].includes(String(value.outcome)) ||
    !text(value.evidence) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(relativePath)
  )
    invalid("verification result has invalid review evidence");
  return value as unknown as VerificationFinding;
}

export function parseVerificationResult(
  content: string,
  expected: VerificationState,
): VerificationResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("structured verification result required");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["schemaVersion", "inputs", "output"]) ||
    value.schemaVersion !== 1 ||
    !strings(value.inputs) ||
    new Set(value.inputs).size !== value.inputs.length ||
    [...value.inputs].sort().join("\n") !== [...expected.assignment.inputs].sort().join("\n") ||
    !object(value.output)
  )
    invalid("structured verification result required");
  const output = value.output;
  if (
    !exactKeys(output, [
      "kind",
      "assignmentId",
      "incrementId",
      "implementationArtifactId",
      "baseCommit",
      "evaluatedCommit",
      "verdict",
      "tests",
      "criteria",
      "review",
      "rejection",
    ]) ||
    output.kind !== "verification_result" ||
    output.assignmentId !== expected.assignment.id ||
    output.incrementId !== expected.incrementId ||
    output.implementationArtifactId !== expected.implementation.artifactId ||
    output.baseCommit !== expected.implementation.baseCommit ||
    output.evaluatedCommit !== expected.implementation.evaluatedCommit ||
    !["verified", "rejected"].includes(String(output.verdict)) ||
    !Array.isArray(output.tests) ||
    !output.tests.length ||
    !output.tests.every(
      (test) =>
        object(test) &&
        exactKeys(test, ["command", "exitCode", "outputPath"]) &&
        text(test.command) &&
        integer(test.exitCode) &&
        artifactPath(test.outputPath),
    ) ||
    !Array.isArray(output.criteria) ||
    !object(output.review) ||
    !exactKeys(output.review, ["regressions", "scope", "simplicity"])
  )
    invalid("verification result does not satisfy its contract");
  const expectedCriteria = new Set(expected.assignment.criteria.map((criterion) => criterion.id));
  const actualCriteria = new Set<string>();
  const criteria = output.criteria.map((criterion) => {
    if (
      !object(criterion) ||
      !exactKeys(criterion, ["criterionId", "outcome", "evidence", "paths"]) ||
      !text(criterion.criterionId) ||
      actualCriteria.has(criterion.criterionId)
    )
      invalid("verification result needs unique evidence for every criterion");
    actualCriteria.add(criterion.criterionId);
    return {
      criterionId: criterion.criterionId,
      ...parseFinding({
        outcome: criterion.outcome,
        evidence: criterion.evidence,
        paths: criterion.paths,
      }),
    };
  });
  if (
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((id) => !actualCriteria.has(id))
  )
    invalid("verification result needs evidence for every selected criterion");
  const review = {
    regressions: parseFinding(output.review.regressions),
    scope: parseFinding(output.review.scope),
    simplicity: parseFinding(output.review.simplicity),
  };
  const failures = [
    ...criteria.map((criterion) => criterion.outcome),
    ...Object.values(review).map((finding) => finding.outcome),
    ...output.tests.map((test) => (test.exitCode === 0 ? "passed" : "failed")),
  ].some((outcome) => outcome === "failed");
  const rejection = output.rejection;
  const validRejection =
    rejection === null ||
    (object(rejection) &&
      (exactKeys(rejection, ["cause", "evidence", "paths"]) ||
        exactKeys(rejection, ["cause", "evidence", "paths", "knowledgeFeedback"])) &&
      text(rejection.cause) &&
      text(rejection.evidence) &&
      Array.isArray(rejection.paths) &&
      rejection.paths.every(relativePath) &&
      (rejection.knowledgeFeedback === undefined ||
        rejection.knowledgeFeedback === null ||
        (object(rejection.knowledgeFeedback) &&
          exactKeys(rejection.knowledgeFeedback, ["reason"]) &&
          knowledgeFeedbackReason(rejection.knowledgeFeedback.reason))));
  if (
    !validRejection ||
    (output.verdict === "verified" && (failures || rejection !== null)) ||
    (output.verdict === "rejected" && (!failures || rejection === null))
  )
    invalid("verification verdict is inconsistent with its evidence");
  return value as unknown as VerificationResult;
}
