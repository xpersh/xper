import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { RecordedEvent } from "../bridge/xper-client.js";
import {
  completeImplementation,
  completeVerification,
  fixtures,
  sealPlan,
  sealTwoIncrementPlan,
  setup,
} from "./workflow-harness.js";

test("Verifier feedback revisits Knowledge and revised delivery requires an explicit checkout revision", async (t) => {
  for (const [reason, target, resumeCommit] of [
    ["ambiguous_criteria", "define", "2222222222222222222222222222222222222222"],
    [
      "infeasible_design",
      "design",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ] as const) {
    await t.test(`${reason} reopens ${target}`, async () => {
      const h = await setup({ maxAttempts: 20 });
      try {
        const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
        assert(fixturePlan?.kind === "execution_plan");
        const plan = structuredClone(fixturePlan);
        for (const assignment of plan.assignments) assignment.maxAttempts = 3;
        await sealPlan(h, plan);
        await completeImplementation(h, "2222222222222222222222222222222222222222");
        h.setWorkspace({
          root: h.cwd,
          head: "2222222222222222222222222222222222222222",
          clean: true,
          status: "",
        });
        const rejected = await completeVerification(
          h,
          "rejected",
          "provider/model",
          h.controller,
          reason,
        );
        assert.equal(rejected.finished.handoffPhase, target);
        const revisiting = await h.controller.getRunStatus();
        assert.equal(revisiting.workflow?.phase, target);
        assert.equal(revisiting.reconciliation?.status, "revisiting");
        const requested = revisiting.timeline.findIndex(
          (event) => (event as RecordedEvent).type === "knowledge.feedback_requested",
        );
        const revisited = revisiting.timeline.findIndex(
          (event) => (event as RecordedEvent).type === "phase.revisited",
        );
        assert(requested >= 0 && revisited > requested);
        await assert.rejects(
          h.controller.resumeDelivery(resumeCommit),
          /finish and seal the Knowledge revisit/,
        );

        const phases =
          target === "define"
            ? ["define", "design", "breakdown", "plan"]
            : ["design", "breakdown", "plan"];
        for (const phase of phases) {
          const produced = await h.produce(phase === "plan" ? plan : undefined);
          assert.equal(produced.assignment.phase, phase);
          if (phase === target)
            assert(
              produced.assignment.inputArtifacts?.some(
                (artifact) => artifact.artifact_id === rejected.artifactId,
              ),
            );
          const advanced = await h.controller.advanceRun();
          assert.equal(advanced.advanced, true, JSON.stringify(advanced));
          if (phase === "plan") assert.equal(advanced.resumeRequired, true);
        }
        await assert.rejects(
          h.controller.startAssignment(undefined, "provider/model"),
          /requires \/xper resume/,
        );

        const restored = await h.restore();
        assert.equal((await restored.getRunStatus()).reconciliation?.status, "awaiting_resume");
        await assert.rejects(restored.resumeDelivery("not-a-commit"), /full lowercase Git commit/);
        h.setWorkspace({
          root: h.cwd,
          head: resumeCommit,
          clean: false,
          status: " M src/change.ts",
        });
        await assert.rejects(restored.resumeDelivery(resumeCommit), /clean dedicated checkout/);
        h.setWorkspace({
          root: h.cwd,
          head: resumeCommit,
          clean: true,
          status: "",
        });
        const otherCommit = "3333333333333333333333333333333333333333";
        await assert.rejects(
          restored.resumeDelivery(otherCommit),
          /does not match the checkout HEAD/,
        );
        const resumed = await restored.resumeDelivery(resumeCommit);
        assert.equal(resumed.replayed, false);
        assert.equal((await restored.resumeDelivery(resumeCommit)).replayed, true);
        await assert.rejects(
          restored.resumeDelivery(otherCommit),
          /already resumed from a different checkout revision/,
        );
        const implementation = await restored.startAssignment(undefined, "provider/model");
        assert.equal(implementation.workflow, "implementation");
        if (implementation.workflow === "implementation") {
          assert.equal(implementation.baseCommit, resumeCommit);
          assert(
            !implementation.inputArtifacts?.some(
              (artifact) => artifact.artifact_id === rejected.artifactId,
            ),
          );
        }
      } finally {
        await h.cleanup();
      }
    });
  }
});

test("a revised Plan invalidates every prior approval and restarts delivery from the selected commit", async () => {
  const h = await setup({ maxAttempts: 40 });
  try {
    const outputs = await sealTwoIncrementPlan(h, true, 3);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    const priorApproval = await completeVerification(h, "verified");
    await completeImplementation(h, "3333333333333333333333333333333333333333");
    h.setWorkspace({
      root: h.cwd,
      head: "3333333333333333333333333333333333333333",
      clean: true,
      status: "",
    });
    await completeVerification(h, "rejected", "provider/model", h.controller, "ambiguous_criteria");

    for (const phase of ["define", "design", "breakdown", "plan"]) {
      const output =
        phase === "define"
          ? outputs.definition
          : phase === "breakdown"
            ? outputs.breakdown
            : phase === "plan"
              ? outputs.plan
              : undefined;
      await h.produce(output);
      const advanced = await h.controller.advanceRun();
      assert.equal(advanced.advanced, true, JSON.stringify(advanced));
      if (phase === "plan") assert.equal(advanced.resumeRequired, true);
    }

    const awaiting = await h.controller.getRunStatus();
    assert.equal(awaiting.reconciliation?.status, "awaiting_resume");
    assert(
      awaiting.timeline.some(
        (event) =>
          (event as RecordedEvent).type === "artifact.invalidated" &&
          (event as RecordedEvent).data.artifactId === priorApproval.artifactId &&
          (event as RecordedEvent).data.reason === "revised Plan requires fresh delivery evidence",
      ),
    );
    await h.controller.resumeDelivery("3333333333333333333333333333333333333333");
    const restarted = await completeImplementation(h, "4444444444444444444444444444444444444444");
    assert.equal(restarted.assignment.workflow, "implementation");
    if (restarted.assignment.workflow === "implementation") {
      assert.equal(restarted.assignment.incrementId, "s1");
      assert.equal(restarted.assignment.baseCommit, "3333333333333333333333333333333333333333");
      assert(
        !restarted.assignment.inputArtifacts?.some(
          (artifact) => artifact.artifact_id === priorApproval.artifactId,
        ),
      );
    }
    h.setWorkspace({
      root: h.cwd,
      head: "4444444444444444444444444444444444444444",
      clean: true,
      status: "",
    });
    const freshApproval = await completeVerification(h, "verified");
    assert.notEqual(freshApproval.artifactId, priorApproval.artifactId);
    const restored = await h.restore();
    assert.equal((await restored.getRunStatus()).verifications?.s1?.nodeId, "verified");
  } finally {
    await h.cleanup();
  }
});

test("recovery completes one persisted Verification feedback handoff without Rust", async () => {
  const h = await setup({ maxAttempts: 20 });
  try {
    const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
    assert(fixturePlan?.kind === "execution_plan");
    const plan = structuredClone(fixturePlan);
    for (const assignment of plan.assignments) assignment.maxAttempts = 3;
    await sealPlan(h, plan);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    await h.controller.waitForRecording();
    const journalPath = join(
      h.cwd,
      ".xper",
      "pi",
      `${createHash("sha256").update("session").digest("hex")}.json`,
    );
    const before = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: { knowledge: unknown; authorizedPlan: unknown };
    };
    await completeVerification(h, "rejected", "provider/model", h.controller, "ambiguous_criteria");
    await h.controller.waitForRecording();
    const after = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: {
        knowledge: unknown;
        authorizedPlan: unknown;
        reconciliations: unknown[];
      };
      pending: unknown[];
      rejected?: unknown[];
    };
    after.state.knowledge = before.state.knowledge;
    after.state.authorizedPlan = before.state.authorizedPlan;
    after.state.reconciliations = [];
    after.pending = [];
    after.rejected = [];
    await writeFile(journalPath, JSON.stringify(after));

    h.recorder.offline = true;
    const restored = await h.restore();
    const recovered = await restored.getRunStatus();
    assert.equal(recovered.workflow?.phase, "define");
    assert.equal(recovered.reconciliation?.status, "revisiting");
    const recoveredJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: { knowledge: { visits: Array<{ phase: string }> } };
    };
    assert.equal(
      recoveredJournal.state.knowledge.visits.filter((visit) => visit.phase === "define").length,
      2,
    );

    const replayed = await h.restore();
    assert.equal((await replayed.getRunStatus()).workflow?.phase, "define");
    const replayedJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: { knowledge: { visits: Array<{ phase: string }> } };
    };
    assert.equal(
      replayedJournal.state.knowledge.visits.filter((visit) => visit.phase === "define").length,
      2,
    );
  } finally {
    h.recorder.offline = false;
    await h.cleanup();
  }
});

test("Knowledge feedback settlement never awaits an unresponsive recorder", async () => {
  const h = await setup({ maxAttempts: 9 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await sealPlan(h);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    await h.controller.waitForRecording();
    const append = h.recorder.appendEvents.bind(h.recorder);
    h.recorder.appendEvents = async (events) => {
      await held;
      return append(events);
    };
    const completed = await Promise.race([
      completeVerification(h, "rejected", "provider/model", h.controller, "ambiguous_criteria"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("verification awaited Rust")), 250),
      ),
    ]);
    assert.equal(completed.assignment.workflow, "verification");
    assert.equal(completed.finished.handoffPhase, "define");
    const status = await h.controller.getRunStatus();
    assert.equal(status.verifications?.s1?.nodeId, "rejected");
    assert.equal(status.workflow?.phase, "define");
    assert.equal(status.reconciliation?.status, "revisiting");
  } finally {
    release();
    await h.cleanup();
  }
});
