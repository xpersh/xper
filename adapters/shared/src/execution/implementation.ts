import type { ExecutionResult, ImplementationExecution } from "../actions/execution.js";
import type { Proposal } from "./implementation-proposal.js";
import { parseProposal } from "./implementation-proposal.js";
import { runTestCommand } from "./test-command.js";
import { changedFiles, inspectGitWorkspace, isDescendant } from "./workspace.js";

export interface ImplementationExecutionDependencies {
  runChild(task: string, timeoutMs: number): Promise<ExecutionResult>;
  now?: () => number;
}

export async function runImplementation(
  request: ImplementationExecution,
  dependencies: ImplementationExecutionDependencies,
): Promise<ExecutionResult> {
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
  })}\n\nRead AGENTS.md and every supplied artifact. Implement only this increment in the current checkout. Run useful tests, commit all intended changes locally, leave the checkout clean, and never push. ${request.reworkReportId ? "Judge-authorized rework: if this increment already satisfies its criteria and Judge feedback, leave the revision unchanged and supply fresh tests and criterion evidence. Never create an empty commit." : "A new commit with actual changes is required."} Return only JSON: {"schemaVersion":1,"testCommands":["exact command to rerun"],"criteria":[{"criterionId":"...","evidence":"...","paths":["relative/path"]}]}. Do not report exit statuses; the host reruns every command.`;
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
  const revalidation = afterChild.head === baseCommit && request.reworkReportId;
  if (afterChild.head === baseCommit && !revalidation)
    return {
      outcome: "failed",
      reason: "Implementer did not create a resulting commit",
      usage: child.usage,
    };
  if (!revalidation && !(await isDescendant(request.cwd, baseCommit, afterChild.head)))
    return {
      outcome: "failed",
      reason: "resulting commit does not descend from the recorded base",
      usage: child.usage,
    };
  const files = await changedFiles(request.cwd, baseCommit, afterChild.head);
  if (!files.length && !revalidation)
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
      ...(revalidation ? { revalidationOf: request.reworkReportId } : {}),
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
