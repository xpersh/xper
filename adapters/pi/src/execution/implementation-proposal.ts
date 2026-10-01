import type { ImplementationExecution } from "../actions/execution.js";

export interface Proposal {
  schemaVersion: 1;
  testCommands: string[];
  criteria: Array<{ criterionId: string; evidence: string; paths: string[] }>;
}

export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseProposal(
  content: string,
  criteria: NonNullable<ImplementationExecution["criteria"]>,
): Proposal {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Implementer must return the required JSON report");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "criteria,schemaVersion,testCommands" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  )
    throw new Error("Implementer report has an unsupported shape");
  const proposal = value as Partial<Proposal>;
  if (
    !Array.isArray(proposal.testCommands) ||
    !proposal.testCommands.length ||
    proposal.testCommands.length > 16 ||
    !proposal.testCommands.every((command) => text(command) && command.length <= 4_096) ||
    !Array.isArray(proposal.criteria)
  )
    throw new Error("Implementer report needs explicit local test commands and criterion evidence");
  const expected = new Set(criteria.map((criterion) => criterion.id));
  const actual = new Set<string>();
  for (const item of proposal.criteria) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "criterionId,evidence,paths" ||
      !text(item.criterionId) ||
      !text(item.evidence) ||
      !Array.isArray(item.paths) ||
      !item.paths.every(
        (path) => text(path) && !path.startsWith("/") && !path.split(/[\\/]/).includes(".."),
      ) ||
      actual.has(item.criterionId)
    )
      throw new Error("Implementer report has invalid criterion evidence");
    actual.add(item.criterionId);
  }
  if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id)))
    throw new Error("Implementer report must cover every selected criterion exactly once");
  return proposal as Proposal;
}
