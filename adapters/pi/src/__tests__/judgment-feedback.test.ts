import assert from "node:assert/strict";
import test from "node:test";
import { PiWorkflow } from "../workflow/controller.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import type { JudgmentReport, Verdict } from "../workflow/judgment/contract.js";
import { runBudget } from "../workflow/delivery/budget.js";
import { parseImplementationResult } from "../workflow/implementation/result.js";
import { ready, reportFor } from "./judgment-harness.js";
import {
  completeImplementation,
  completeVerification,
  fixtures,
  twoIncrementOutputs,
} from "./workflow-harness.js";

async function judge(
  h: Awaited<ReturnType<typeof ready>>,
  verdict: Verdict,
  controller = h.controller,
) {
  const assignment = await controller.startAssignment(undefined, "provider/judge");
  assert(assignment.workflow === "judgment" && assignment.artifactPath);
  const report = JSON.parse(reportFor(assignment)) as JudgmentReport;
  report.output.verdict = verdict;
  report.output.reason = "Review the cited behavior and design evidence";
  const content = JSON.stringify(report);
  h.artifacts.set(assignment.artifactPath, { content, digest: content });
  const result = await controller.finishAttempt({
    attemptId: assignment.attemptId,
    outcome: "succeeded",
    artifactPath: assignment.artifactPath,
  });
  assert(!result.replayed && result.artifactId);
  return {
    reportId: result.artifactId,
    revision: assignment.evaluation.evaluatedCommit,
    assignment,
  };
}
async function checkpoint(h: Awaited<ReturnType<typeof ready>>) {
  const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
  await journal.load();
  const decoded = decodeAdapterCheckpoint(journal.state);
  assert(decoded);
  return decoded;
}
function workspace(h: Awaited<ReturnType<typeof ready>>, head: string, clean = true) {
  h.setWorkspace({ root: h.cwd, head, clean, status: clean ? "" : " M tracked.txt" });
}

test("whole-Plan Judge rework requires fresh evidence, preserves cumulative diff and replays across judgments", async () => {
  for (const revisions of [
    ["4", "5"],
    ["3", "4"],
    ["3", "3"],
  ]) {
    const h = await ready(null, 3);
    try {
      const first = await judge(h, "REWORK_IMPLEMENTATION");
      await assert.rejects(
        h.controller.startAssignment(undefined, "provider/model"),
        /already recorded/,
      );
      const applied = await h.controller.applyJudgment(first.reportId, first.revision);
      assert.equal(applied.status, "reopened");
      const status = await h.controller.getRunStatus();
      assert.equal(status.closure, undefined);
      assert.deepEqual(status.verifications, {});
      assert.equal(status.feedback?.reportId, first.reportId);
      const before = await checkpoint(h);
      const restored = await h.restore();
      for (const [index, digit] of revisions.entries()) {
        const result = await completeImplementation(
          h,
          digit.repeat(40),
          "provider/different",
          restored,
        );
        assert.equal(result.assignment.incrementId, `s${index + 1}`);
        assert.equal(result.assignment.reworkReportId, first.reportId);
        assert.equal(result.assignment.model, "provider/model");
        assert(
          result.assignment.inputArtifacts?.some((input) => input.artifact_id === first.reportId),
        );
        workspace(h, digit.repeat(40));
        await completeVerification(h, "verified", "provider/model", restored);
      }
      const second = await judge(h, "ACCEPT", restored);
      assert.notEqual(second.reportId, first.reportId);
      assert.equal(second.assignment.evaluation.baseCommit, "1".repeat(40));
      assert(
        second.assignment.evaluation.artifacts.some(
          (input) => input.artifact_id === first.reportId,
        ),
      );
      const oldIds = new Set(
        first.assignment.evaluation.artifacts
          .filter((input) => input.kind === "verification_result")
          .map((input) => input.artifact_id),
      );
      assert(
        second.assignment.evaluation.artifacts
          .filter((input) => input.kind === "verification_result")
          .every((input) => !oldIds.has(input.artifact_id)),
      );
      assert.deepEqual(await restored.applyJudgment(first.reportId, first.revision), {
        ...applied,
        replayed: true,
      });
      await assert.rejects(restored.applyJudgment(first.reportId, "f".repeat(40)), /exact Judge/);
      const after = await checkpoint(h);
      assert.equal(runBudget(before, 1000).attempts - runBudget(after, 1000).attempts, 5);
      assert.equal(after.implementations.s1?.length, 2);
      const closure = await restored.applyJudgment(second.reportId, second.revision);
      assert.equal(closure.status, "accepted");
      const loaded = await h.restore();
      assert.equal((await loaded.applyJudgment(first.reportId, first.revision)).replayed, true);
      assert.equal((await loaded.getRunStatus()).closure?.reportId, second.reportId);
      assert.equal(
        (
          await loaded.finishAttempt({
            attemptId: first.assignment.attemptId,
            outcome: "succeeded",
            artifactPath: first.assignment.artifactPath!,
          })
        ).replayed,
        true,
      );
    } finally {
      await h.cleanup();
    }
  }
});

test("Judge Define and Design feedback reuse Knowledge and require explicit revised-Plan resumption", async () => {
  for (const verdict of ["REDEFINE", "REVISIT_DESIGN"] as const) {
    const h = await ready(null, 3);
    try {
      const source = await judge(h, verdict);
      const decision = await h.controller.applyJudgment(source.reportId, source.revision);
      assert.equal(decision.status, "reopened");
      const expectedPhase = verdict === "REDEFINE" ? "define" : "design";
      assert.equal((await h.controller.getRunStatus()).workflow?.phase, expectedPhase);
      assert.equal((await checkpoint(h)).knowledge.accepted.plan, undefined);
      const restored = await h.restore();
      const visits = (await restored.getRunStatus()).run?.visits.length;
      await restored.applyJudgment(source.reportId, source.revision);
      assert.equal((await restored.getRunStatus()).run?.visits.length, visits);
      const outputs = twoIncrementOutputs(true);
      for (const assignment of outputs.plan.assignments) assignment.maxAttempts = 3;
      const phases =
        expectedPhase === "define"
          ? ["define", "design", "breakdown", "plan"]
          : ["design", "breakdown", "plan"];
      for (const phase of phases) {
        const assignment = await restored.startAssignment();
        assert.equal(assignment.phase, phase);
        assert(assignment.artifactPath);
        if (phase === expectedPhase)
          assert(assignment.inputArtifacts?.some((input) => input.artifact_id === source.reportId));
        const output =
          phase === "define"
            ? outputs.definition
            : phase === "breakdown"
              ? outputs.breakdown
              : phase === "plan"
                ? outputs.plan
                : fixtures.find((fixture) => fixture.phase === phase)?.artifact.output;
        const content = JSON.stringify({
          schemaVersion: 1,
          inputs: assignment.inputArtifacts?.map((input) => input.artifact_id),
          output,
        });
        h.artifacts.set(assignment.artifactPath, { content, digest: content });
        await restored.finishAttempt({
          attemptId: assignment.attemptId,
          outcome: "succeeded",
          artifactPath: assignment.artifactPath,
        });
        assert((await restored.advanceRun()).advanced);
      }
      await assert.rejects(restored.startAssignment(undefined, "provider/model"), /resume/);
      await restored.resumeDelivery(source.revision);
      const loaded = await h.restore();
      for (const digit of ["4", "5"]) {
        const next = await completeImplementation(h, digit.repeat(40), "provider/model", loaded);
        assert.equal(next.assignment.reworkReportId, undefined);
        workspace(h, digit.repeat(40));
        await completeVerification(h, "verified", "provider/model", loaded);
      }
      const final = await judge(h, "ACCEPT", loaded);
      await loaded.applyJudgment(final.reportId, final.revision);
      assert.equal((await checkpoint(h)).closure?.reportId, final.reportId);
    } finally {
      await h.cleanup();
    }
  }
});

test("Judge feedback rejects changed revisions and evidence before applying anything", async () => {
  const h = await ready(null, 3);
  try {
    const source = await judge(h, "REWORK_IMPLEMENTATION");
    const legacy = await checkpoint(h);
    const { judgmentHistory: _history, ...versionSeven } = legacy;
    assert.deepEqual(decodeAdapterCheckpoint({ ...versionSeven, version: 7 }), legacy);
    const originalImplementation = legacy.implementations.s1?.at(-1);
    assert(originalImplementation?.lifecycle.status === "completed");
    const registered =
      originalImplementation.artifacts[originalImplementation.lifecycle.artifactId];
    assert(registered);
    const originalResult = h.artifacts.get(registered.path);
    assert(originalResult);
    const noChange = JSON.parse(originalResult.content);
    noChange.output.resultingCommit = originalImplementation.baseCommit;
    noChange.output.changedFiles = [];
    noChange.output.revalidationOf = source.reportId;
    assert.throws(
      () => parseImplementationResult(JSON.stringify(noChange), originalImplementation),
      /contract/,
    );
    assert.throws(
      () =>
        parseImplementationResult(JSON.stringify(noChange), {
          ...originalImplementation,
          reworkReportId: "another-report",
        }),
      /contract/,
    );
    for (const [head, clean] of [
      ["f".repeat(40), true],
      [source.revision, false],
    ] as const) {
      workspace(h, head, clean);
      await assert.rejects(
        h.controller.applyJudgment(source.reportId, source.revision),
        /clean evaluated revision/,
      );
      assert.equal((await checkpoint(h)).judgmentHistory.length, 0);
    }
    workspace(h, source.revision);
    const input = source.assignment.evaluation.artifacts[0];
    assert(input);
    const original = h.artifacts.get(input.path);
    assert(original);
    h.artifacts.set(input.path, { ...original, digest: "changed" });
    await assert.rejects(
      h.controller.applyJudgment(source.reportId, source.revision),
      /evidence changed/,
    );
    assert.equal((await checkpoint(h)).judgmentHistory.length, 0);
    h.artifacts.set(input.path, original);
    await h.controller.applyJudgment(source.reportId, source.revision);
    const state = await checkpoint(h);
    for (const mutate of [
      (value: typeof state) => {
        value.judgmentHistory[0]!.decision.evaluatedCommit = "f".repeat(40);
      },
      (value: typeof state) => {
        value.judgmentHistory[0]!.state.evaluation.artifacts[0]!.digest = "wrong";
      },
      (value: typeof state) => {
        value.authorizedPlan!.reworkReportId = "missing";
      },
      (value: typeof state) => {
        value.judgmentHistory.push(structuredClone(value.judgmentHistory[0]!));
      },
    ]) {
      const corrupted = structuredClone(state);
      mutate(corrupted);
      assert.throws(() => decodeAdapterCheckpoint(corrupted));
    }
  } finally {
    await h.cleanup();
  }
});

test("interrupted Judge rework retries explicitly with frozen inputs and spent assignment budgets", async () => {
  const h = await ready(null, 3);
  try {
    const source = await judge(h, "REWORK_IMPLEMENTATION");
    await h.controller.applyJudgment(source.reportId, source.revision);
    const started = await h.controller.startAssignment(undefined, "provider/model");
    assert(started.workflow === "implementation");
    const restored = await h.restore();
    await assert.rejects(
      restored.startAssignment(undefined, "provider/other"),
      /retry interrupted.*explicitly/,
    );
    const retried = await restored.startAssignment(started.assignmentId, "provider/other");
    assert(retried.workflow === "implementation");
    assert.equal(retried.model, started.model);
    assert.equal(retried.baseCommit, started.baseCommit);
    assert.deepEqual(retried.inputArtifacts, started.inputArtifacts);
    assert.notEqual(retried.attemptId, started.attemptId);
    await restored.finishAttempt({ attemptId: retried.attemptId, outcome: "cancelled" });
    const state = await checkpoint(h);
    assert.equal(
      state.implementations.s1?.at(-1)?.attempts[started.attemptId]?.outcome,
      "interrupted",
    );
    assert.match(
      (await restored.getRunStatus()).unresolvedReason ?? "",
      /assignment.*attempt budget/,
    );
    await assert.rejects(
      restored.startAssignment(undefined, "provider/model"),
      /assignment attempt budget/,
    );
  } finally {
    await h.cleanup();
  }
});

test("successive Judge feedback decisions retain ordered evidence and separate delivery authorizations", async () => {
  const h = await ready(null, 3);
  try {
    const first = await judge(h, "REWORK_IMPLEMENTATION");
    await h.controller.applyJudgment(first.reportId, first.revision);
    for (let index = 0; index < 2; index++) {
      await completeImplementation(h, first.revision);
      await completeVerification(h, "verified");
    }
    const second = await judge(h, "REWORK_IMPLEMENTATION");
    await h.controller.applyJudgment(second.reportId, second.revision);
    const restored = await h.restore();
    const next = await restored.startAssignment(undefined, "provider/model");
    assert(next.workflow === "implementation");
    assert.equal(next.reworkReportId, second.reportId);
    assert.equal((await restored.applyJudgment(first.reportId, first.revision)).replayed, true);
    const state = await checkpoint(h);
    assert.equal(state.judgmentHistory.length, 2);
    assert.equal(state.implementations.s1?.length, 3);
    const corrupted = structuredClone(state);
    corrupted.judgmentHistory.reverse();
    assert.throws(() => decodeAdapterCheckpoint(corrupted), /historical Judge/);
  } finally {
    await h.cleanup();
  }
});

test("exhausted budgets leave Judge feedback unresolved without refunding or executing", async () => {
  for (const reason of ["assignment", "attempt", "time", "cost"] as const) {
    const h = await ready(null, reason === "assignment" ? 1 : 3);
    try {
      const source = await judge(h, "REWORK_IMPLEMENTATION");
      const state = await checkpoint(h);
      if (reason === "attempt") state.knowledge.policy.maxAttempts = 10;
      if (reason === "time") h.advanceTime(state.knowledge.policy.maxTimeMs);
      if (reason === "cost") {
        state.knowledge.policy.attemptCostMicros = 1;
        state.knowledge.policy.maxCostMicros = 10;
      }
      if (reason === "attempt" || reason === "cost") {
        await h.controller.waitForRecording();
        await h.controller.stopRecording();
        const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
        await journal.load();
        await journal.commit(state, []);
        await journal.close();
      }
      const restored = await h.restore();
      assert.equal(
        (await restored.applyJudgment(source.reportId, source.revision)).status,
        "reopened",
      );
      assert.match((await restored.getRunStatus()).unresolvedReason ?? "", new RegExp(reason));
      await assert.rejects(restored.startAssignment(undefined, "provider/model"), /budget/);
      const after = await checkpoint(h);
      assert.equal(after.judgmentHistory.length, 1);
      assert.equal(Object.values(after.implementations).flat().length, 2);
      assert.equal((await restored.getRunStatus()).closure, undefined);
    } finally {
      await h.cleanup();
    }
  }
});

test("Judge feedback application and local recovery never wait for a recorder", async () => {
  for (const mode of ["missing", "rejecting", "unanswered"] as const) {
    const h = await ready(null, 3);
    let controller: PiWorkflow | undefined;
    try {
      const source = await judge(h, "REDEFINE");
      await h.controller.stopRecording();
      const recorder = {
        appendEvents: async () => {
          if (mode === "unanswered") return new Promise<never>(() => {});
          throw new Error(mode === "missing" ? "offline" : "event rejected");
        },
      };
      controller = new PiWorkflow(recorder, h.cwd, "session", h.options);
      const result = await Promise.race([
        controller.applyJudgment(source.reportId, source.revision),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("recorder blocked feedback")), 1000);
          timer.unref();
        }),
      ]);
      assert.equal(result.status, "reopened");
      assert.equal((await controller.getRunStatus()).workflow?.phase, "define");
      await controller.stopRecording();
      controller = new PiWorkflow(recorder, h.cwd, "session", h.options);
      assert.equal((await controller.getRunStatus()).workflow?.phase, "define");
      assert.equal(
        (await controller.applyJudgment(source.reportId, source.revision)).replayed,
        true,
      );
    } finally {
      await controller?.stopRecording();
      await h.cleanup();
    }
  }
});
