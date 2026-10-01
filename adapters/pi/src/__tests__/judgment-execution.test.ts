import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JudgmentExecution } from "../actions/execution.js";
import { saveArtifact } from "../execution/artifacts.js";
import { runPiChild } from "../execution/child.js";
import { runJudgment } from "../execution/judgment.js";
import { resolveAgent, toolsForRole } from "../execution/roles.js";
import { readEvidence } from "../workflow/evidence.js";
import { parseJudgmentReport } from "../workflow/judgment/contract.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const proposal = JSON.stringify({
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
async function checkout() {
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

test("Judge receives fresh frozen context and a complete host diff with only the read tool", async () => {
  const h = await checkout();
  try {
    const command = join(h.cwd, ".xper/fake-pi.cjs");
    await writeFile(
      command,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('.xper/child-args.json', JSON.stringify(process.argv.slice(2)));
process.stdin.once('data', data => {
  fs.writeFileSync('.xper/child-prompt.json', data);
  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'observed-provider',responseModel:'observed-model',content:[{type:'text',text:${JSON.stringify(proposal)}}]}})+'\\n');
  process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
});
`,
      { mode: 0o755 },
    );
    const result = await runJudgment(h.request, {
      readEvidence: h.readEvidence,
      runChild: (task, timeoutMs) =>
        runPiChild(task, h.cwd, h.signal.signal, {
          command,
          timeoutMs,
          systemPrompt: resolveAgent(h.request.role).systemPrompt,
          model: "synthetic/judge",
          tools: toolsForRole(h.request.role),
        }),
    });
    assert.equal(result.outcome, "succeeded", result.reason);
    assert(result.brief);
    parseJudgmentReport(result.brief, h.request.evaluation, "judge");
    const args = JSON.parse(
      await readFile(join(h.cwd, ".xper/child-args.json"), "utf8"),
    ) as string[];
    assert.equal(args[args.indexOf("--tools") + 1], "read");
    for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-context-files"])
      assert(args.includes(flag));
    const prompt = await readFile(join(h.cwd, ".xper/child-prompt.json"), "utf8");
    assert.match(prompt, /-base/);
    assert.match(prompt, /\+implemented/);
    assert(!prompt.includes(h.request.task));
    assert.equal(result.usage?.[0]?.model, "observed-model");
    assert.equal(git(h.cwd, "status", "--porcelain"), "");
  } finally {
    await rm(h.cwd, { recursive: true, force: true });
  }
});

test("Judge detects dirty source, revision drift and changed input evidence without cleanup", async (t) => {
  for (const mutation of ["source", "commit", "artifact", "missing"])
    await t.test(mutation, async () => {
      const h = await checkout();
      try {
        const result = await runJudgment(h.request, {
          readEvidence: h.readEvidence,
          runChild: async () => {
            if (mutation === "source" || mutation === "commit")
              await writeFile(join(h.cwd, "source.txt"), "mutated\n");
            if (mutation === "commit") git(h.cwd, "commit", "--quiet", "-am", "unexpected");
            if (mutation === "artifact")
              await writeFile(
                join(
                  h.cwd,
                  h.request.evaluation.artifacts[0]?.path ?? assert.fail("missing input"),
                ),
                "changed evidence",
              );
            if (mutation === "missing")
              await rm(
                join(
                  h.cwd,
                  h.request.evaluation.artifacts[0]?.path ?? assert.fail("missing input"),
                ),
              );
            return { outcome: "succeeded", brief: proposal };
          },
        });
        assert.equal(result.outcome, "failed");
        assert.equal(result.brief, undefined);
        if (mutation === "source")
          assert.equal(await readFile(join(h.cwd, "source.txt"), "utf8"), "mutated\n");
      } finally {
        await rm(h.cwd, { recursive: true, force: true });
      }
    });
});

test("Judge does not execute on stale checkout and preserves cancellation, timeout and malformed output", async () => {
  const h = await checkout();
  try {
    let calls = 0;
    const runChild = async () => {
      calls++;
      return { outcome: "succeeded" as const, brief: proposal };
    };
    h.request.evaluation.evaluatedCommit = h.request.evaluation.baseCommit;
    assert.equal(
      (await runJudgment(h.request, { readEvidence: h.readEvidence, runChild })).outcome,
      "failed",
    );
    assert.equal(calls, 0);
    h.request.evaluation.evaluatedCommit = git(h.cwd, "rev-parse", "HEAD");
    for (const outcome of ["cancelled", "timed_out", "failed"] as const)
      assert.equal(
        (
          await runJudgment(h.request, {
            readEvidence: h.readEvidence,
            runChild: async () => ({ outcome }),
          })
        ).outcome,
        outcome,
      );
    const malformed = await runJudgment(h.request, {
      readEvidence: h.readEvidence,
      runChild: async () => ({ outcome: "succeeded", brief: "not JSON" }),
    });
    assert.equal(malformed.outcome, "failed");
    let now = 0;
    const late = await runJudgment(h.request, {
      readEvidence: h.readEvidence,
      now: () => now,
      runChild: async () => {
        now = h.request.timeoutMs;
        return { outcome: "succeeded", brief: proposal };
      },
    });
    assert.equal(late.outcome, "timed_out");
    h.signal.abort();
    assert.equal(
      (await runJudgment(h.request, { readEvidence: h.readEvidence, runChild })).outcome,
      "cancelled",
    );
    assert.equal(calls, 0);
  } finally {
    await rm(h.cwd, { recursive: true, force: true });
  }
});

test("an oversized diff fails before the Judge instead of silently truncating evidence", async () => {
  const h = await checkout();
  try {
    await writeFile(join(h.cwd, "source.txt"), "x".repeat(1_100_000));
    git(h.cwd, "commit", "--quiet", "-am", "large change");
    h.request.evaluation.evaluatedCommit = git(h.cwd, "rev-parse", "HEAD");
    let called = false;
    const result = await runJudgment(h.request, {
      readEvidence: h.readEvidence,
      runChild: async () => {
        called = true;
        return { outcome: "succeeded", brief: proposal };
      },
    });
    assert.equal(called, false);
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /maxBuffer/);
  } finally {
    await rm(h.cwd, { recursive: true, force: true });
  }
});
