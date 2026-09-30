import type {
  KnowledgeExecution,
  KnowledgeExecutionResult,
} from "../actions/delegate-knowledge.js";
import { inspectGitWorkspace, runTestCommand } from "../implementation/workspace.js";

type Outcome = "passed" | "failed";
interface Finding {
  outcome: Outcome;
  evidence: string;
  paths: string[];
}
interface Proposal {
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

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const relativePath = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.split(/[\\/]/).includes("..");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function finding(value: unknown): Finding {
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

function parseProposal(
  content: string,
  criteria: NonNullable<KnowledgeExecution["criteria"]>,
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

export interface VerificationExecutionDependencies {
  runChild(task: string, timeoutMs: number): Promise<KnowledgeExecutionResult>;
  now?: () => number;
}

/** Run a non-repairing review, then independently execute the combined test evidence. */
export async function runVerification(
  request: KnowledgeExecution,
  dependencies: VerificationExecutionDependencies,
): Promise<KnowledgeExecutionResult> {
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
