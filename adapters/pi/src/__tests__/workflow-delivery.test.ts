import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../bridge/xper-client.js";
import { WorkflowJournal } from "../workflow/journal.js";
import type { Document } from "../workflow/knowledge/contract.js";
import {
  completeImplementation,
  completeVerification,
  fixtures,
  sealPlan,
  sealTwoIncrementPlan,
  setup,
} from "./workflow-harness.js";

test("explicit delivery verifies one exact implementation without finishing the run", async () => {
  const h = await setup();
  try {
    await sealPlan(h);
    const implemented = await completeImplementation(
      h,
      "2222222222222222222222222222222222222222",
      "provider/frozen-model",
    );
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    const verified = await completeVerification(h, "verified", "provider/replacement-model");
    assert.equal(verified.assignment.implementationArtifactId, implemented.artifactId);
    assert.equal(verified.assignment.model, "provider/replacement-model");
    const status = await h.controller.getRunStatus();
    assert.equal(status.implementations?.s1?.nodeId, "implemented");
    assert.equal(status.verifications?.s1?.nodeId, "verified");
    assert(!status.timeline.some((event) => (event as RecordedEvent).type === "run.finished"));
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /all planned increments are verified; the run is ready for Judgment Day/,
    );
  } finally {
    await h.cleanup();
  }
});

test("dependent increments advance explicitly in one checkout and survive reload", async () => {
  const h = await setup({ maxAttempts: 9 });
  try {
    await sealTwoIncrementPlan(h);
    const firstImplementation = await completeImplementation(
      h,
      "2222222222222222222222222222222222222222",
    );
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    const firstVerification = await completeVerification(h, "verified");
    const beforeReload = await h.controller.getRunStatus();
    assert.equal(beforeReload.implementations?.s2, undefined);
    assert.equal(beforeReload.verifications?.s2, undefined);

    const restored = await h.restore();
    const recovered = await restored.getRunStatus();
    assert.equal(recovered.verifications?.s1?.nodeId, "verified");
    assert.equal(recovered.implementations?.s2, undefined);

    const secondImplementation = await completeImplementation(
      h,
      "3333333333333333333333333333333333333333",
      "provider/model",
      restored,
    );
    assert.equal(secondImplementation.assignment.incrementId, "s2");
    assert.equal(
      secondImplementation.assignment.baseCommit,
      "2222222222222222222222222222222222222222",
    );
    assert(secondImplementation.assignment.inputArtifacts);
    assert(
      secondImplementation.assignment.inputArtifacts.some(
        (artifact) => artifact.artifact_id === firstVerification.artifactId,
      ),
    );
    assert(
      !secondImplementation.assignment.inputArtifacts.some(
        (artifact) => artifact.artifact_id === firstImplementation.artifactId,
      ),
    );
    h.setWorkspace({
      root: h.cwd,
      head: "3333333333333333333333333333333333333333",
      clean: true,
      status: "",
    });
    const secondVerification = await completeVerification(
      h,
      "verified",
      "provider/model",
      restored,
    );
    assert.notEqual(secondImplementation.artifactId, firstImplementation.artifactId);
    assert.notEqual(secondVerification.artifactId, firstVerification.artifactId);
    const status = await restored.getRunStatus();
    assert.equal(status.implementations?.s1?.nodeId, "implemented");
    assert.equal(status.verifications?.s1?.nodeId, "verified");
    assert.equal(status.implementations?.s2?.nodeId, "implemented");
    assert.equal(status.verifications?.s2?.nodeId, "verified");
    assert(!status.timeline.some((event) => (event as RecordedEvent).type === "run.finished"));
    await assert.rejects(
      restored.startAssignment(undefined, "provider/model"),
      /all planned increments are verified; the run is ready for Judgment Day/,
    );
  } finally {
    await h.cleanup();
  }
});

test("a rejected prerequisite remains the only delivery frontier", async () => {
  const h = await setup();
  try {
    await sealTwoIncrementPlan(h, true, 2);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    await completeVerification(h, "rejected");
    const rework = await h.controller.startAssignment(undefined, "provider/model");
    assert.equal(rework.workflow, "implementation");
    if (rework.workflow !== "implementation") assert.fail("implementation rework expected");
    assert.equal(rework.incrementId, "s1");
    assert.equal((await h.controller.getRunStatus()).implementations?.s2, undefined);
  } finally {
    await h.cleanup();
  }
});

test("a later increment requires the latest verified checkout revision", async () => {
  const h = await setup({ maxAttempts: 9 });
  try {
    await sealTwoIncrementPlan(h);
    await completeImplementation(h, "2222222222222222222222222222222222222222");
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    await completeVerification(h, "verified");
    h.setWorkspace({
      root: h.cwd,
      head: "9999999999999999999999999999999999999999",
      clean: true,
      status: "",
    });
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /checkout revision does not match the latest verified increment/,
    );
    assert.equal((await h.controller.getRunStatus()).implementations?.s2, undefined);
  } finally {
    await h.cleanup();
  }
});

test("rejection preserves evidence and budgets while rework creates fresh instances", async () => {
  const h = await setup();
  try {
    const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
    assert(fixturePlan?.kind === "execution_plan");
    const plan = structuredClone(fixturePlan);
    for (const assignment of plan.assignments) assignment.maxAttempts = 2;
    await sealPlan(h, plan);
    const firstImplementation = await completeImplementation(
      h,
      "2222222222222222222222222222222222222222",
      "provider/frozen-implementer",
    );
    h.setWorkspace({
      root: h.cwd,
      head: "2222222222222222222222222222222222222222",
      clean: true,
      status: "",
    });
    const firstVerification = await completeVerification(h, "rejected", "provider/frozen-verifier");
    const rework = await h.controller.startAssignment(undefined, "provider/changed-implementer");
    assert.equal(rework.workflow, "implementation");
    if (rework.workflow !== "implementation") assert.fail("implementation rework expected");
    assert.equal(rework.baseCommit, "2222222222222222222222222222222222222222");
    assert.equal(rework.model, "provider/frozen-implementer");
    assert.equal(rework.budget?.attempts, 0);
    assert.deepEqual(
      rework.inputArtifacts?.slice(-2).map((artifact) => artifact.artifact_id),
      [firstImplementation.artifactId, firstVerification.artifactId],
    );
    assert(rework.artifactPath);
    const reworkContent = JSON.stringify({
      schemaVersion: 1,
      inputs: rework.inputArtifacts?.map((artifact) => artifact.artifact_id),
      output: {
        kind: "implementation_result",
        assignmentId: rework.assignmentId,
        incrementId: rework.incrementId,
        baseCommit: rework.baseCommit,
        resultingCommit: "3333333333333333333333333333333333333333",
        changedFiles: ["src/change.ts"],
        tests: [
          {
            command: "npm test",
            exitCode: 0,
            outputPath: `.xper/artifacts/test-output-${rework.attemptId}-1.log`,
          },
        ],
        criteria: rework.criteria.map((criterion) => ({
          criterionId: criterion.id,
          evidence: "rework test passes",
          paths: ["src/change.ts"],
        })),
      },
    });
    h.artifacts.set(rework.artifactPath, { content: reworkContent, digest: reworkContent });
    const completedRework = await h.controller.finishAttempt({
      attemptId: rework.attemptId,
      outcome: "succeeded",
      artifactPath: rework.artifactPath,
    });
    assert.equal(completedRework.replayed, undefined);
    if (completedRework.replayed) assert.fail("new rework result expected");
    h.setWorkspace({
      root: h.cwd,
      head: "3333333333333333333333333333333333333333",
      clean: true,
      status: "",
    });
    const secondVerification = await h.controller.startAssignment(
      undefined,
      "provider/changed-verifier",
    );
    assert.equal(secondVerification.workflow, "verification");
    if (secondVerification.workflow !== "verification") assert.fail("verification expected");
    assert.equal(secondVerification.model, "provider/frozen-verifier");
    assert.equal(secondVerification.implementationArtifactId, completedRework.artifactId);
    assert.equal(secondVerification.evaluatedCommit, "3333333333333333333333333333333333333333");
    assert.equal(secondVerification.budget?.attempts, 0);
    assert.notEqual(secondVerification.attemptId, firstVerification.assignment.attemptId);
    const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
    await journal.load();
    const state = journal.state as {
      implementations: Record<string, unknown[]>;
      verifications: Record<string, unknown[]>;
    };
    assert.equal(state.implementations.s1?.length, 2);
    assert.equal(state.verifications.s1?.length, 2);
    await journal.close();
  } finally {
    await h.cleanup();
  }
});

test("an unsupported historical Plan is rejected before implementation state or facts exist", async () => {
  const h = await setup();
  try {
    const planPath = await sealPlan(h);
    const original = h.artifacts.get(planPath);
    assert(original);
    const historical = JSON.parse(original.content) as Document;
    assert.equal(historical.output.kind, "execution_plan");
    historical.output.assignments = historical.output.assignments.filter(
      (assignment) => assignment.role !== "verify.verifier",
    );
    h.artifacts.set(planPath, {
      content: JSON.stringify(historical),
      // The evidence reader is the digest boundary. Keeping this seal simulates
      // a Plan accepted by an older validator without pretending it was edited.
      digest: original.digest,
    });
    const before = await h.controller.getRunStatus();
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /sealed Plan is unsupported; replan before delivery/,
    );
    const after = await h.controller.getRunStatus();
    assert.equal(after.implementations, undefined);
    assert.equal(after.timeline.length, before.timeline.length);
    assert(
      !after.timeline.some((event) => (event as RecordedEvent).type === "implementation.started"),
    );
    h.artifacts.set(planPath, { content: original.content, digest: "modified" });
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /artifact changed after registration/,
    );
    assert.equal((await h.controller.getRunStatus()).implementations, undefined);
  } finally {
    await h.cleanup();
  }
});

test("a dirty initial checkout is rejected before creating an implementation attempt", async () => {
  const h = await setup();
  try {
    await sealPlan(h);
    const before = await h.controller.getRunStatus();
    h.setWorkspace({
      root: h.cwd,
      head: "1111111111111111111111111111111111111111",
      clean: false,
      status: " M src/change.ts",
    });
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /initially clean dedicated checkout/,
    );
    const after = await h.controller.getRunStatus();
    assert.equal(after.implementations, undefined);
    assert.equal(after.timeline.length, before.timeline.length);
  } finally {
    await h.cleanup();
  }
});

test("a ready Plan is revalidated against sealed evidence and remaining time", async () => {
  const h = await setup();
  try {
    let planPath = "";
    for (let i = 0; i < 5; i++) {
      const result = await h.produce();
      planPath = result.assignment.artifactPath ?? "";
      await h.controller.advanceRun();
    }
    const original = h.artifacts.get(planPath);
    assert(original);
    h.artifacts.set(planPath, { content: "changed", digest: "changed" });
    const changed = await h.controller.advanceRun();
    assert.equal(changed.advanced, false);
    if (!changed.advanced) assert.match(changed.reason, /changed/);
    h.artifacts.set(planPath, original);
    h.advanceTime(3600000);
    const expired = await h.controller.advanceRun();
    assert.equal(expired.advanced, false);
    if (!expired.advanced) assert.match(expired.reason, /time budget/);
  } finally {
    await h.cleanup();
  }
});
