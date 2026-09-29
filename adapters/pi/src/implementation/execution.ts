import type {
  KnowledgeExecution,
  KnowledgeExecutionResult,
} from "../actions/delegate-knowledge.js";
import { changedFiles, inspectGitWorkspace, isDescendant, runTestCommand } from "./workspace.js";

interface Proposal {
  schemaVersion: 1;
  testCommands: string[];
  criteria: Array<{ criterionId: string; evidence: string; paths: string[] }>;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
function parseProposal(
  content: string,
  criteria: NonNullable<KnowledgeExecution["criteria"]>,
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

export interface ImplementationExecutionDependencies {
  runChild(task: string, timeoutMs: number): Promise<KnowledgeExecutionResult>;
  now?: () => number;
}

/** Run the mutating child, then independently observe Git and execute its declared tests. */
export async function runImplementation(
  request: KnowledgeExecution,
  dependencies: ImplementationExecutionDependencies,
): Promise<KnowledgeExecutionResult> {
  const {
    assignmentId,
    incrementId,
    baseCommit,
    criteria,
    verification,
    inputArtifacts = [],
    attemptId,
  } = request;
  if (
    !attemptId ||
    !assignmentId ||
    !incrementId ||
    !baseCommit ||
    !criteria?.length ||
    !verification?.length
  )
    return { outcome: "failed", reason: "implementation handoff is incomplete" };
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const childTask = `${request.task}\n\nAuthoritative implementation assignment:\n${JSON.stringify({
    assignmentId,
    incrementId,
    baseCommit,
    criteria,
    verification,
    inputArtifacts,
  })}\n\nRead AGENTS.md and every supplied artifact. Implement only this increment in the current checkout. Run useful tests, commit all intended changes locally, leave the checkout clean, and never push. Return only JSON: {"schemaVersion":1,"testCommands":["exact command to rerun"],"criteria":[{"criterionId":"...","evidence":"...","paths":["relative/path"]}]}. Do not report exit statuses; the host reruns every command.`;
  const child = await dependencies.runChild(childTask, request.timeoutMs);
  if (child.outcome !== "succeeded") return child;
  if (request.signal.aborted) return { outcome: "cancelled", usage: child.usage };
  if (!child.brief?.trim())
    return {
      outcome: "failed",
      reason: "Implementer returned no structured report",
      usage: child.usage,
    };
  let proposal: Proposal;
  try {
    proposal = parseProposal(child.brief, criteria);
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : "invalid Implementer report",
      usage: child.usage,
    };
  }
  const afterChild = await inspectGitWorkspace(request.cwd).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "Git inspection failed",
  }));
  if ("error" in afterChild)
    return { outcome: "failed", reason: afterChild.error, usage: child.usage };
  if (!afterChild.clean)
    return {
      outcome: "failed",
      reason: "Implementer left uncommitted or untracked files in the checkout",
      usage: child.usage,
    };
  if (afterChild.head === baseCommit)
    return {
      outcome: "failed",
      reason: "Implementer did not create a resulting commit",
      usage: child.usage,
    };
  if (!(await isDescendant(request.cwd, baseCommit, afterChild.head)))
    return {
      outcome: "failed",
      reason: "resulting commit does not descend from the recorded base",
      usage: child.usage,
    };
  const files = await changedFiles(request.cwd, baseCommit, afterChild.head);
  if (!files.length)
    return {
      outcome: "failed",
      reason: "resulting commit contains no local change",
      usage: child.usage,
    };
  const tests: Array<{ command: string; exitCode: number; outputPath: string }> = [];
  for (const [index, command] of proposal.testCommands.entries()) {
    const remaining = request.timeoutMs - Math.max(0, now() - startedAt);
    if (remaining <= 0)
      return {
        outcome: "timed_out",
        reason: "implementation deadline expired",
        usage: child.usage,
      };
    const result = await runTestCommand(
      command,
      request.cwd,
      attemptId,
      index,
      remaining,
      request.signal,
    );
    if (result.cancelled) return { outcome: "cancelled", usage: child.usage };
    if (result.timedOut)
      return { outcome: "timed_out", reason: `test timed out: ${command}`, usage: child.usage };
    tests.push({ command, exitCode: result.exitCode, outputPath: result.outputPath });
  }
  if (request.signal.aborted) return { outcome: "cancelled", usage: child.usage };
  if (now() - startedAt >= request.timeoutMs)
    return {
      outcome: "timed_out",
      reason: "implementation deadline expired",
      usage: child.usage,
    };
  const afterTests = await inspectGitWorkspace(request.cwd);
  if (!afterTests.clean || afterTests.head !== afterChild.head)
    return {
      outcome: "failed",
      reason: "host-run tests changed evaluated source or the resulting commit",
      usage: child.usage,
    };
  const brief = JSON.stringify({
    schemaVersion: 1,
    inputs: inputArtifacts.map((artifact) => artifact.artifact_id),
    output: {
      kind: "implementation_result",
      assignmentId,
      incrementId,
      baseCommit,
      resultingCommit: afterChild.head,
      changedFiles: files,
      tests,
      criteria: proposal.criteria,
    },
  });
  const failed = tests.some((test) => test.exitCode !== 0);
  return {
    outcome: failed ? "failed" : "succeeded",
    brief,
    ...(failed ? { reason: "one or more host-run tests failed" } : {}),
    usage: child.usage,
  };
}
