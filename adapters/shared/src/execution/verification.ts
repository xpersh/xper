import type { ExecutionResult, VerificationExecution } from "../actions/execution.js";
import { runTestCommand } from "./test-command.js";
import type { Proposal } from "./verification-proposal.js";
import { parseProposal } from "./verification-proposal.js";
import { inspectGitWorkspace } from "./workspace.js";

export interface VerificationExecutionDependencies {
  runChild(task: string, timeoutMs: number): Promise<ExecutionResult>;
  now?: () => number;
}

export async function runVerification(
  request: VerificationExecution,
  dependencies: VerificationExecutionDependencies,
): Promise<ExecutionResult> {
  const {
    attemptId,
    assignmentId,
    incrementId,
    implementationArtifactId,
    baseCommit,
    evaluatedCommit,
    implementationTestCommands,
    criteria,
    verification,
    inputArtifacts = [],
  } = request;
  if (
    !attemptId ||
    !assignmentId ||
    !incrementId ||
    !implementationArtifactId ||
    !baseCommit ||
    !evaluatedCommit ||
    !implementationTestCommands?.length ||
    !criteria?.length ||
    !verification?.length
  )
    return { outcome: "failed", reason: "verification handoff is incomplete" };
  const initial = await inspectGitWorkspace(request.cwd).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "Git inspection failed",
  }));
  if ("error" in initial) return { outcome: "failed", reason: initial.error };
  if (!initial.clean || initial.head !== evaluatedCommit)
    return {
      outcome: "failed",
      reason: "verification checkout does not match the clean evaluated revision",
    };
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const childTask = `${request.task}\n\nAuthoritative verification assignment:\n${JSON.stringify({
    assignmentId,
    incrementId,
    implementationArtifactId,
    baseCommit,
    evaluatedCommit,
    criteria,
    verification,
    inputArtifacts,
  })}\n\nRead AGENTS.md, every supplied artifact, the referenced test logs, and the complete Git diff from baseCommit to evaluatedCommit. Independently check behavior, regressions, unrequested scope, and unnecessary complexity. Do not edit, write, commit, reset, clean, or repair anything. Return only JSON: {"schemaVersion":1,"verdict":"verified"|"rejected","testCommands":["additional exact command"],"criteria":[{"criterionId":"...","outcome":"passed"|"failed","evidence":"...","paths":["relative/path"]}],"review":{"regressions":{"outcome":"passed"|"failed","evidence":"...","paths":[]},"scope":{"outcome":"passed"|"failed","evidence":"...","paths":[]},"simplicity":{"outcome":"passed"|"failed","evidence":"...","paths":[]}},"rejection":null|{"cause":"...","evidence":"...","paths":[],"knowledgeFeedback":null|{"reason":"ambiguous_criteria"|"infeasible_design"}}}. Use knowledgeFeedback only when the defect belongs to Define or Design; otherwise use null for implementation rework. Do not report test exit statuses; the host runs the Implementer's commands first, then your additional commands.`;
  const child = await dependencies.runChild(childTask, request.timeoutMs);
  if (child.outcome !== "succeeded") return child;
  if (request.signal.aborted) return { outcome: "cancelled", usage: child.usage };
  const afterChild = await inspectGitWorkspace(request.cwd).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "Git inspection failed",
  }));
  if ("error" in afterChild)
    return { outcome: "failed", reason: afterChild.error, usage: child.usage };
  if (!afterChild.clean || afterChild.head !== evaluatedCommit)
    return {
      outcome: "failed",
      reason: "Verifier changed evaluated source or the evaluated commit",
      usage: child.usage,
    };
  if (!child.brief?.trim())
    return {
      outcome: "failed",
      reason: "Verifier returned no structured report",
      usage: child.usage,
    };
  let proposal: Proposal;
  try {
    proposal = parseProposal(child.brief, criteria);
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : "invalid Verifier report",
      usage: child.usage,
    };
  }
  const commands = [...new Set([...implementationTestCommands, ...proposal.testCommands])];
  const tests: Array<{ command: string; exitCode: number; outputPath: string }> = [];
  for (const [index, command] of commands.entries()) {
    const remaining = request.timeoutMs - Math.max(0, now() - startedAt);
    if (remaining <= 0)
      return { outcome: "timed_out", reason: "verification deadline expired", usage: child.usage };
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
    const afterTest = await inspectGitWorkspace(request.cwd);
    if (!afterTest.clean || afterTest.head !== evaluatedCommit)
      return {
        outcome: "failed",
        reason: "host-run verification tests changed evaluated source or the evaluated commit",
        usage: child.usage,
      };
  }
  if (request.signal.aborted) return { outcome: "cancelled", usage: child.usage };
  if (now() - startedAt >= request.timeoutMs)
    return { outcome: "timed_out", reason: "verification deadline expired", usage: child.usage };
  const failedTests = tests.filter((test) => test.exitCode !== 0);
  const verdict = failedTests.length ? "rejected" : proposal.verdict;
  const rejection = failedTests.length
    ? {
        cause: "host test failed",
        evidence: failedTests
          .map((test) => `${test.command} exited ${test.exitCode}; see ${test.outputPath}`)
          .join("; "),
        paths: failedTests.map((test) => test.outputPath),
        knowledgeFeedback: null,
      }
    : proposal.rejection;
  const brief = JSON.stringify({
    schemaVersion: 1,
    inputs: inputArtifacts.map((artifact) => artifact.artifact_id),
    output: {
      kind: "verification_result",
      assignmentId,
      incrementId,
      implementationArtifactId,
      baseCommit,
      evaluatedCommit,
      verdict,
      tests,
      criteria: proposal.criteria,
      review: proposal.review,
      rejection,
    },
  });
  return { outcome: "succeeded", brief, usage: child.usage };
}
