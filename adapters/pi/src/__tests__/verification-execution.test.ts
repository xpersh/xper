import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VerificationExecution } from "../actions/execution.js";
import { runVerification } from "../execution/verification.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function checkout() {
  const cwd = await mkdtemp(join(tmpdir(), "xper-verification-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "xper test");
  git(cwd, "config", "user.email", "xper@example.invalid");
  await writeFile(join(cwd, ".gitignore"), ".xper/\n");
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  git(cwd, "add", ".gitignore", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "tracked.txt"), "implemented\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "implement");
  return { cwd, base, evaluated: git(cwd, "rev-parse", "HEAD") };
}

function request(
  cwd: string,
  baseCommit: string,
  evaluatedCommit: string,
  implementationTestCommands: string[],
): VerificationExecution {
  return {
    attemptId: "verification-1",
    assignmentId: "verifier",
    incrementId: "s1",
    workflow: "verification",
    task: "Verify the increment",
    role: "verify.verifier",
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    model: "synthetic/model",
    inputArtifacts: [
      {
        artifact_id: "implementation-result",
        kind: "implementation_result",
        path: ".xper/artifacts/implementation-result.json",
        version: 1,
      },
    ],
    artifactKind: "verification_result",
    implementationArtifactId: "implementation-result",
    baseCommit,
    evaluatedCommit,
    implementationTestCommands,
    criteria: [{ id: "c1", behavior: "Change the file", example: "implemented value" }],
    verification: ["read the changed value"],
    budget: { attempts: 1, timeMs: 10_000, costMicros: null, concurrency: 1 },
  };
}

function proposal(
  verdict: "verified" | "rejected" = "verified",
  testCommands: string[] = [],
  knowledgeFeedback?: "ambiguous_criteria" | "infeasible_design",
) {
  const failed = verdict === "rejected";
  return JSON.stringify({
    schemaVersion: 1,
    verdict,
    testCommands,
    criteria: [
      {
        criterionId: "c1",
        outcome: failed ? "failed" : "passed",
        evidence: failed ? "The value is wrong" : "The value is implemented",
        paths: ["tracked.txt"],
      },
    ],
    review: {
      regressions: { outcome: "passed", evidence: "No regression found", paths: [] },
      scope: { outcome: "passed", evidence: "Diff is focused", paths: ["tracked.txt"] },
      simplicity: { outcome: "passed", evidence: "Change is direct", paths: ["tracked.txt"] },
    },
    rejection: failed
      ? {
          cause: "criterion failed",
          evidence: "Observed wrong value",
          paths: ["tracked.txt"],
          knowledgeFeedback: knowledgeFeedback ? { reason: knowledgeFeedback } : null,
        }
      : null,
  });
}

test("an unchanged authorized implementation receives fresh independent verification and host tests", async () => {
  const { cwd, evaluated } = await checkout();
  try {
    const command = `node -e "process.stdout.write('independent revalidation')"`;
    const result = await runVerification(request(cwd, evaluated, evaluated, [command]), {
      runChild: async () => ({ outcome: "succeeded", brief: proposal() }),
    });
    assert.equal(result.outcome, "succeeded");
    assert(result.brief);
    const { output } = JSON.parse(result.brief);
    assert.equal(output.verdict, "verified");
    assert.equal(output.evaluatedCommit, evaluated);
    assert.match(
      await readFile(join(cwd, output.tests[0].outputPath), "utf8"),
      /independent revalidation/,
    );
    assert.equal(git(cwd, "status", "--porcelain"), "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verification runs implementation tests before deduplicated reviewer additions", async () => {
  const { cwd, base, evaluated } = await checkout();
  try {
    const baseCommand = "node -e \"process.stdout.write('base')\"";
    const extraCommand = "node -e \"process.stdout.write('extra')\"";
    const result = await runVerification(request(cwd, base, evaluated, [baseCommand]), {
      runChild: async () => ({
        outcome: "succeeded",
        brief: proposal("verified", [baseCommand, extraCommand]),
      }),
    });
    assert.equal(result.outcome, "succeeded");
    assert(result.brief);
    const artifact = JSON.parse(result.brief) as {
      output: {
        verdict: string;
        tests: Array<{ command: string; exitCode: number; outputPath: string }>;
      };
    };
    assert.equal(artifact.output.verdict, "verified");
    assert.deepEqual(
      artifact.output.tests.map((entry) => entry.command),
      [baseCommand, extraCommand],
    );
    assert.match(
      await readFile(join(cwd, artifact.output.tests[0]?.outputPath ?? ""), "utf8"),
      /base/,
    );
    assert.match(
      await readFile(join(cwd, artifact.output.tests[1]?.outputPath ?? ""), "utf8"),
      /extra/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a failing host test overrides an approving Verifier with rejection evidence", async () => {
  const { cwd, base, evaluated } = await checkout();
  try {
    const result = await runVerification(
      request(cwd, base, evaluated, ['node -e "process.exit(7)"']),
      {
        runChild: async () => ({ outcome: "succeeded", brief: proposal() }),
      },
    );
    assert.equal(result.outcome, "succeeded");
    assert(result.brief);
    const artifact = JSON.parse(result.brief) as {
      output: {
        verdict: string;
        rejection: { cause: string; knowledgeFeedback: unknown };
        tests: Array<{ exitCode: number }>;
      };
    };
    assert.equal(artifact.output.verdict, "rejected");
    assert.equal(artifact.output.rejection.cause, "host test failed");
    assert.equal(artifact.output.rejection.knowledgeFeedback, null);
    assert.equal(artifact.output.tests[0]?.exitCode, 7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a Verifier can request structured Knowledge feedback when host tests pass", async () => {
  const { cwd, base, evaluated } = await checkout();
  try {
    const command = 'node -e "process.exit(0)"';
    const result = await runVerification(request(cwd, base, evaluated, [command]), {
      runChild: async () => ({
        outcome: "succeeded",
        brief: proposal("rejected", [], "infeasible_design"),
      }),
    });
    assert.equal(result.outcome, "succeeded");
    assert(result.brief);
    const artifact = JSON.parse(result.brief) as {
      output: { rejection: { knowledgeFeedback: { reason: string } } };
    };
    assert.equal(artifact.output.rejection.knowledgeFeedback.reason, "infeasible_design");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Verifier and test mutations invalidate evidence without repairing the checkout", async () => {
  const childMutation = await checkout();
  try {
    const result = await runVerification(
      request(childMutation.cwd, childMutation.base, childMutation.evaluated, [
        'node -e "process.exit(0)"',
      ]),
      {
        runChild: async () => {
          await writeFile(join(childMutation.cwd, "tracked.txt"), "reviewer changed it\n");
          return { outcome: "succeeded", brief: proposal() };
        },
      },
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /Verifier changed evaluated source/);
    assert.match(git(childMutation.cwd, "status", "--porcelain"), /tracked\.txt/);
  } finally {
    await rm(childMutation.cwd, { recursive: true, force: true });
  }

  const testMutation = await checkout();
  try {
    const command = "node -e \"require('node:fs').writeFileSync('tracked.txt','test changed it')\"";
    const result = await runVerification(
      request(testMutation.cwd, testMutation.base, testMutation.evaluated, [command]),
      { runChild: async () => ({ outcome: "succeeded", brief: proposal() }) },
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /tests changed evaluated source/);
    assert.match(git(testMutation.cwd, "status", "--porcelain"), /tracked\.txt/);
  } finally {
    await rm(testMutation.cwd, { recursive: true, force: true });
  }
});

test("Verifier HEAD drift invalidates an otherwise clean review checkout", async () => {
  const changed = await checkout();
  try {
    const result = await runVerification(
      request(changed.cwd, changed.base, changed.evaluated, ['node -e "process.exit(0)"']),
      {
        runChild: async () => {
          git(changed.cwd, "commit", "--quiet", "--allow-empty", "-m", "reviewer drift");
          return { outcome: "succeeded", brief: proposal() };
        },
      },
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.reason ?? "", /Verifier changed evaluated source/);
    assert.notEqual(git(changed.cwd, "rev-parse", "HEAD"), changed.evaluated);
    assert.equal(git(changed.cwd, "status", "--porcelain"), "");
  } finally {
    await rm(changed.cwd, { recursive: true, force: true });
  }
});

test("verification preserves cancellation and a shared deadline without an artifact", async () => {
  const cancelled = await checkout();
  try {
    const controller = new AbortController();
    const execution = request(cancelled.cwd, cancelled.base, cancelled.evaluated, [
      'node -e "process.exit(0)"',
    ]);
    execution.signal = controller.signal;
    const result = await runVerification(execution, {
      runChild: async () => {
        controller.abort();
        return { outcome: "succeeded", brief: proposal() };
      },
    });
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.brief, undefined);
  } finally {
    await rm(cancelled.cwd, { recursive: true, force: true });
  }

  const timedOut = await checkout();
  try {
    let now = 0;
    const execution = request(timedOut.cwd, timedOut.base, timedOut.evaluated, [
      'node -e "process.exit(0)"',
    ]);
    execution.timeoutMs = 100;
    const result = await runVerification(execution, {
      now: () => now,
      runChild: async () => {
        now = 100;
        return { outcome: "succeeded", brief: proposal() };
      },
    });
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.brief, undefined);
  } finally {
    await rm(timedOut.cwd, { recursive: true, force: true });
  }
});
