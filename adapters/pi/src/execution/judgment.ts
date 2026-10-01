import type { ExecutionResult, JudgmentExecution } from "../actions/execution.js";
import { git, inspectGitWorkspace } from "./workspace.js";

interface Dependencies {
  runChild(task: string, timeoutMs: number): Promise<ExecutionResult>;
  readEvidence(path: string): Promise<{ digest: string }>;
  now?: () => number;
}
async function checkEvidence(
  request: JudgmentExecution,
  read: Dependencies["readEvidence"],
): Promise<void> {
  for (const input of [...request.evaluation.artifacts, ...request.evaluation.logs])
    if ((await read(input.path)).digest !== input.digest)
      throw new Error("Judgment evidence digest changed");
  const workspace = await inspectGitWorkspace(request.cwd);
  if (!workspace.clean || workspace.head !== request.evaluation.evaluatedCommit)
    throw new Error("Judgment requires the clean evaluated revision");
}
export async function runJudgment(
  request: JudgmentExecution,
  dependencies: Dependencies,
): Promise<ExecutionResult> {
  const now = dependencies.now ?? Date.now;
  const started = now();
  let child: ExecutionResult | undefined;
  try {
    if (request.signal.aborted) return { outcome: "cancelled" };
    await checkEvidence(request, dependencies.readEvidence);
    const { baseCommit, evaluatedCommit } = request.evaluation;
    const diff = await git(request.cwd, [
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      baseCommit,
      evaluatedCommit,
      "--",
    ]);
    if (request.signal.aborted) return { outcome: "cancelled" };
    const remaining = request.timeoutMs - (now() - started);
    if (remaining <= 0) return { outcome: "timed_out" };
    const task = `Evaluate this frozen assignment. The accepted Discovery and Definition describe the intent. Read every supplied artifact and referenced log. Review the final source as needed. No new tests or commands are allowed.\n${JSON.stringify(request.evaluation)}\nDiff reference: git:${baseCommit}..${evaluatedCommit}\nComplete diff:\n${diff}\nReturn only JSON: {"verdict":"ACCEPT"|"ACCEPT_WITH_DEBT"|"REWORK_IMPLEMENTATION"|"REVISIT_DESIGN"|"REDEFINE"|"HUMAN_DECISION"|"REJECT","reason":"...","criteria":[{"criterionId":"...","outcome":"passed"|"failed"|"uncertain","reason":"...","evidence":["supplied artifact ID or exact diff reference"]}],"criticisms":[{"reason":"...","evidence":["supplied artifact ID or exact diff reference"]}]}. Include every criterion exactly once. Explain scope, complexity, important decisions, integration risk and debt in your reasoning and criticisms. All verdicts are recommendations only.`;
    child = await dependencies.runChild(task, remaining);
    if (child.outcome !== "succeeded") return child;
    await checkEvidence(request, dependencies.readEvidence);
    if (request.signal.aborted) return { outcome: "cancelled", usage: child.usage };
    if (now() - started >= request.timeoutMs) return { outcome: "timed_out", usage: child.usage };
    const proposal: unknown = JSON.parse(child.brief ?? "");
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
      throw new Error("Judge returned no structured recommendation");
    return {
      outcome: "succeeded",
      brief: JSON.stringify({
        schemaVersion: 1,
        evaluation: request.evaluation,
        output: { ...proposal, kind: "judgment_verdict", assignmentId: request.assignmentId },
      }),
      usage: child.usage,
    };
  } catch (error) {
    return {
      outcome: request.signal.aborted ? "cancelled" : "failed",
      reason: error instanceof Error ? error.message : "Judgment evaluation failed",
      usage: child?.usage,
    };
  }
}
