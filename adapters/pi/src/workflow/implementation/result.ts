import { invalid, object } from "../validation.js";
import type { ImplementationState } from "./state.js";
import { artifactPath, exactKeys, integer, relativePath, sha, text } from "./validation.js";

export interface ImplementationTestResult {
  command: string;
  exitCode: number;
  outputPath: string;
}

export interface ImplementationResult {
  schemaVersion: 1;
  inputs: string[];
  output: {
    kind: "implementation_result";
    assignmentId: string;
    incrementId: string;
    baseCommit: string;
    resultingCommit: string;
    changedFiles: string[];
    tests: ImplementationTestResult[];
    criteria: Array<{ criterionId: string; evidence: string; paths: string[] }>;
  };
}

export function parseImplementationResult(
  content: string,
  expected: Pick<
    ImplementationState,
    "incrementId" | "baseCommit" | "planArtifactId" | "assignment"
  >,
): ImplementationResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    invalid("structured implementation result required");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["schemaVersion", "inputs", "output"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.inputs) ||
    !value.inputs.every(text) ||
    new Set(value.inputs).size !== value.inputs.length ||
    !object(value.output)
  )
    invalid("structured implementation result required");
  const inputs = [...expected.assignment.inputs].sort();
  if ([...value.inputs].sort().join("\n") !== inputs.join("\n"))
    invalid("implementation result input references do not match the sealed handoff");
  const output = value.output;
  if (
    !exactKeys(output, [
      "kind",
      "assignmentId",
      "incrementId",
      "baseCommit",
      "resultingCommit",
      "changedFiles",
      "tests",
      "criteria",
    ]) ||
    output.kind !== "implementation_result" ||
    output.assignmentId !== expected.assignment.id ||
    output.incrementId !== expected.incrementId ||
    output.baseCommit !== expected.baseCommit ||
    !sha(output.resultingCommit) ||
    output.resultingCommit === expected.baseCommit ||
    !Array.isArray(output.changedFiles) ||
    !output.changedFiles.length ||
    !output.changedFiles.every(relativePath) ||
    new Set(output.changedFiles).size !== output.changedFiles.length ||
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
    !Array.isArray(output.criteria)
  )
    invalid("implementation result does not satisfy its contract");
  const expectedCriteria = new Set(expected.assignment.criteria.map((criterion) => criterion.id));
  const actualCriteria = new Set<string>();
  for (const criterion of output.criteria) {
    if (
      !object(criterion) ||
      !exactKeys(criterion, ["criterionId", "evidence", "paths"]) ||
      !text(criterion.criterionId) ||
      !text(criterion.evidence) ||
      !Array.isArray(criterion.paths) ||
      !criterion.paths.every(relativePath) ||
      actualCriteria.has(criterion.criterionId)
    )
      invalid("implementation result needs unique evidence for every criterion");
    actualCriteria.add(criterion.criterionId);
  }
  if (
    actualCriteria.size !== expectedCriteria.size ||
    [...expectedCriteria].some((id) => !actualCriteria.has(id))
  )
    invalid("implementation result needs evidence for every selected criterion");
  return value as unknown as ImplementationResult;
}
