import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImplementationExecution } from "../actions/execution.js";
import { runImplementation } from "../execution/implementation.js";
import { inspectGitWorkspace } from "../execution/workspace.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function checkout() {
  const cwd = await mkdtemp(join(tmpdir(), "xper-implementation-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "xper test");
  git(cwd, "config", "user.email", "xper@example.invalid");
  await writeFile(join(cwd, ".gitignore"), ".xper/\n");
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  git(cwd, "add", ".gitignore", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "base");
  return cwd;
}

function request(cwd: string, command: string): ImplementationExecution {
  return {
    attemptId: "attempt-1",
    assignmentId: "driver",
    incrementId: "s1",
    workflow: "implementation",
    task: `Implement the increment and propose ${command}`,
    role: "implementation.driver",
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    model: "synthetic/model",
    inputArtifacts: [
      {
        artifact_id: "plan",
        kind: "execution_plan",
        path: ".xper/artifacts/plan.json",
        version: 1,
      },
    ],
    artifactKind: "implementation_result",
    baseCommit: git(cwd, "rev-parse", "HEAD"),
    criteria: [{ id: "c1", behavior: "Change the file", example: "new value" }],
    verification: ["read the changed value"],
    budget: { attempts: 1, timeMs: 10_000, costMicros: null, concurrency: 1 },
  };
}

function proposal(command: string) {
  return JSON.stringify({
    schemaVersion: 1,
    testCommands: [command],
    criteria: [
      {
        criterionId: "c1",
        evidence: "The committed file contains the value",
        paths: ["tracked.txt"],
      },
    ],
  });
}

async function commitChange(cwd: string) {
  await writeFile(join(cwd, "tracked.txt"), "implemented\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "implement increment");
}

test("a real checkout records the child commit and host-run test output", async () => {
  const cwd = await checkout();
  try {
    const execution = request(cwd, "node -e \"process.stdout.write('host-pass')\"");
    const result = await runImplementation(execution, {
      runChild: async () => {
        await commitChange(cwd);
        return {
          outcome: "succeeded",
          brief: proposal("node -e \"process.stdout.write('host-pass')\""),
        };
      },
    });
    assert.equal(result.outcome, "succeeded");
    assert(result.brief);
    const artifact = JSON.parse(result.brief) as {
      output: {
        baseCommit: string;
        resultingCommit: string;
        changedFiles: string[];
        tests: Array<{ exitCode: number; outputPath: string }>;
      };
    };
    assert.equal(artifact.output.baseCommit, execution.baseCommit);
    assert.equal(artifact.output.resultingCommit, git(cwd, "rev-parse", "HEAD"));
    assert.deepEqual(artifact.output.changedFiles, ["tracked.txt"]);
    assert.equal(artifact.output.tests[0]?.exitCode, 0);
    assert.match(
      await readFile(join(cwd, artifact.output.tests[0]?.outputPath ?? ""), "utf8"),
      /host-pass/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a model report cannot turn a failing local command into success", async () => {
  const cwd = await checkout();
  try {
    const command = 'node -e "process.exit(7)"';
    const result = await runImplementation(request(cwd, command), {
      runChild: async () => {
        await commitChange(cwd);
        return { outcome: "succeeded", brief: proposal(command) };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /host-run tests failed/);
    assert(result.brief);
    const artifact = JSON.parse(result.brief) as { output: { tests: Array<{ exitCode: number }> } };
    assert.equal(artifact.output.tests[0]?.exitCode, 7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the child and host commands share one implementation deadline", async () => {
  const cwd = await checkout();
  try {
    let now = 0;
    const execution = request(cwd, 'node -e "process.exit(0)"');
    execution.timeoutMs = 100;
    const result = await runImplementation(execution, {
      now: () => now,
      runChild: async () => {
        await commitChange(cwd);
        now = 100;
        return {
          outcome: "succeeded",
          brief: proposal('node -e "process.exit(0)"'),
        };
      },
    });
    assert.equal(result.outcome, "timed_out");
    assert.match(result.reason ?? "", /deadline expired/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing commits and test mutations fail without cleaning the checkout", async () => {
  const noCommit = await checkout();
  try {
    const result = await runImplementation(request(noCommit, 'node -e "process.exit(0)"'), {
      runChild: async () => ({
        outcome: "succeeded",
        brief: proposal('node -e "process.exit(0)"'),
      }),
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /did not create/);
  } finally {
    await rm(noCommit, { recursive: true, force: true });
  }

  const changedByTest = await checkout();
  try {
    const command = "node -e \"require('node:fs').writeFileSync('tracked.txt','changed by test')\"";
    const result = await runImplementation(request(changedByTest, command), {
      runChild: async () => {
        await commitChange(changedByTest);
        return { outcome: "succeeded", brief: proposal(command) };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /tests changed evaluated source/);
    assert.match(git(changedByTest, "status", "--porcelain"), /tracked\.txt/);
  } finally {
    await rm(changedByTest, { recursive: true, force: true });
  }
});

test("real Git inspection exposes dirty and divergent outcomes without repairing them", async () => {
  const initiallyDirty = await checkout();
  try {
    await writeFile(join(initiallyDirty, "tracked.txt"), "uncommitted\n");
    assert.equal((await inspectGitWorkspace(initiallyDirty)).clean, false);
  } finally {
    await rm(initiallyDirty, { recursive: true, force: true });
  }

  const childDirty = await checkout();
  try {
    const result = await runImplementation(request(childDirty, 'node -e "process.exit(0)"'), {
      runChild: async () => {
        await commitChange(childDirty);
        await writeFile(join(childDirty, "uncommitted.txt"), "preserve me\n");
        return {
          outcome: "succeeded",
          brief: proposal('node -e "process.exit(0)"'),
        };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /uncommitted or untracked/);
    assert.match(git(childDirty, "status", "--porcelain"), /uncommitted\.txt/);
  } finally {
    await rm(childDirty, { recursive: true, force: true });
  }

  const diverged = await checkout();
  try {
    const execution = request(diverged, 'node -e "process.exit(0)"');
    const result = await runImplementation(execution, {
      runChild: async () => {
        git(diverged, "checkout", "--quiet", "--orphan", "diverged");
        await writeFile(join(diverged, "tracked.txt"), "diverged\n");
        git(diverged, "add", ".gitignore", "tracked.txt");
        git(diverged, "commit", "--quiet", "-m", "diverged implementation");
        return {
          outcome: "succeeded",
          brief: proposal('node -e "process.exit(0)"'),
        };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /does not descend/);
    assert.equal(git(diverged, "status", "--porcelain"), "");
  } finally {
    await rm(diverged, { recursive: true, force: true });
  }
});
