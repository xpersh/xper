import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgmentExecution } from "../actions/execution.js";
import { saveArtifact } from "../execution/artifacts.js";
import { readEvidence } from "../execution/evidence.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const proposal = JSON.stringify({
  verdict: "ACCEPT",
  reason: "The exact diff meets the intent",
  criteria: [
    {
      criterionId: "c1",
      outcome: "passed",
      reason: "The evidence shows the changed value",
      evidence: ["input"],
    },
  ],
  criticisms: [],
});
export async function checkout() {
  const cwd = await mkdtemp(join(tmpdir(), "xper-judge-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "xper test");
  git(cwd, "config", "user.email", "xper@example.invalid");
  await writeFile(join(cwd, ".gitignore"), ".xper/\n");
  await writeFile(join(cwd, "source.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  const baseCommit = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "source.txt"), "implemented\n");
  git(cwd, "commit", "--quiet", "-am", "implement");
  const evaluatedCommit = git(cwd, "rev-parse", "HEAD");
  const path = await saveArtifact(
    cwd,
    "input",
    '{"intent":"Change the value"}',
    ".xper/artifacts/definition-input.json",
  );
  const evidence = await readEvidence(cwd, path);
  const signal = new AbortController();
  const request: JudgmentExecution = {
    workflow: "judgment",
    assignmentId: "judge",
    task: "PRIVATE PARENT CONVERSATION",
    role: "judgment_day.judge",
    cwd,
    signal: signal.signal,
    timeoutMs: 10000,
    model: "synthetic/judge",
    evaluation: {
      planArtifactId: "input",
      criterionIds: ["c1"],
      incrementIds: ["s1"],
      artifacts: [
        {
          artifact_id: "input",
          kind: "definition_contract",
          path,
          version: 1,
          digest: evidence.digest,
        },
      ],
      logs: [],
      baseCommit,
      evaluatedCommit,
    },
  };
  return { cwd, request, signal, readEvidence: (path: string) => readEvidence(cwd, path) };
}
