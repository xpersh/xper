import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runJudgment } from "../execution/judgment.js";
import { checkout, git, proposal } from "./judgment-execution-harness.js";

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
