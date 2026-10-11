import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../bridge/xper-client.js";
import { completeImplementation, fixtures, sealPlan, setup } from "./workflow-harness.js";

test("implementation recovery interrupts locally and requires the frozen assignment identity", async () => {
  const h = await setup();
  try {
    const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
    assert(fixturePlan?.kind === "execution_plan");
    const plan = structuredClone(fixturePlan);
    const driver = plan.assignments.find(
      (assignment) => assignment.role === "implementation.driver",
    );
    assert(driver);
    driver.maxAttempts = 2;
    await sealPlan(h, plan);
    const started = await h.controller.startAssignment(undefined, "provider/frozen-model");
    assert.equal(started.workflow, "implementation");
    const restored = await h.restore();
    const recovered = await restored.getRunStatus();
    assert.equal(recovered.implementations?.s1?.status, "active");
    assert.deepEqual(recovered.implementations?.s1?.activeAttemptIds, []);
    assert(
      recovered.timeline.some(
        (event) =>
          (event as RecordedEvent).type === "attempt.finished" &&
          (event as RecordedEvent).data.attemptId === started.attemptId &&
          (event as RecordedEvent).data.outcome === "interrupted",
      ),
    );
    await assert.rejects(
      restored.startAssignment(undefined, "provider/changed-model"),
      /retry interrupted assignment driver explicitly/,
    );
    const retry = await restored.startAssignment("driver", "provider/changed-model");
    assert.equal(retry.workflow, "implementation");
    if (retry.workflow === "implementation") {
      assert.equal(retry.model, "provider/frozen-model");
      assert.equal(retry.baseCommit, "1111111111111111111111111111111111111111");
    }
  } finally {
    await h.cleanup();
  }
});

test("verification recovery interrupts locally without launching another reviewer", async () => {
  const h = await setup();
  try {
    const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
    assert(fixturePlan?.kind === "execution_plan");
    const plan = structuredClone(fixturePlan);
    const verifier = plan.assignments.find((assignment) => assignment.role === "verify.verifier");
    assert(verifier);
    verifier.maxAttempts = 2;
    await sealPlan(h, plan);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    const started = await h.controller.startAssignment(undefined, "provider/frozen-verifier");
    assert.equal(started.workflow, "verification");
    const restored = await h.restore();
    const recovered = await restored.getRunStatus();
    assert.equal(recovered.verifications?.s1?.status, "active");
    assert.deepEqual(recovered.verifications?.s1?.activeAttemptIds, []);
    assert(
      recovered.timeline.some(
        (event) =>
          (event as RecordedEvent).type === "attempt.finished" &&
          (event as RecordedEvent).data.attemptId === started.attemptId &&
          (event as RecordedEvent).data.outcome === "interrupted",
      ),
    );
    await assert.rejects(
      restored.startAssignment(undefined, "provider/changed-verifier"),
      /retry interrupted assignment verifier explicitly/,
    );
    const retry = await restored.startAssignment("verifier", "provider/changed-verifier");
    assert.equal(retry.workflow, "verification");
    if (retry.workflow === "verification") {
      assert.equal(retry.model, "provider/frozen-verifier");
      assert.equal(retry.implementationArtifactId, started.implementationArtifactId);
    }
  } finally {
    await h.cleanup();
  }
});
