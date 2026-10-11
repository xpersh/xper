import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../bridge/xper-client.js";
import { policyFrom } from "../workflow/policy.js";
import type { WorkflowPolicy } from "../workflow/types.js";
import { fixtures, setup } from "./workflow-harness.js";

test("Pi owns the knowledge path and ready Plan without a workflow RPC", async () => {
  const h = await setup();
  try {
    for (const phase of ["discovery", "define", "design", "breakdown", "plan"]) {
      const { assignment } = await h.produce();
      assert.equal(assignment.phase, phase);
      const gate = await h.controller.advanceRun();
      assert(gate.advanced);
      if (phase === "plan") assert.equal(gate.ready, true);
    }
    assert.equal((await h.controller.advanceRun()).ready, true);
    const implementation = await h.controller.startAssignment(undefined, "provider/model");
    assert.equal(implementation.workflow, "implementation");
    if (implementation.workflow === "implementation") {
      assert.equal(implementation.incrementId, "s1");
      assert.equal(implementation.role, "implementation.driver");
      assert(implementation.artifactPath);
      const content = JSON.stringify({
        schemaVersion: 1,
        inputs: implementation.inputArtifacts?.map((artifact) => artifact.artifact_id),
        output: {
          kind: "implementation_result",
          assignmentId: implementation.assignmentId,
          incrementId: implementation.incrementId,
          baseCommit: implementation.baseCommit,
          resultingCommit: "2222222222222222222222222222222222222222",
          changedFiles: ["src/change.ts"],
          tests: [
            {
              command: "npm test",
              exitCode: 0,
              outputPath: `.xper/artifacts/test-output-${implementation.attemptId}-1.log`,
            },
          ],
          criteria: implementation.criteria.map((criterion) => ({
            criterionId: criterion.id,
            evidence: "host-observed test",
            paths: ["src/change.ts"],
          })),
        },
      });
      h.artifacts.set(implementation.artifactPath, { content, digest: content });
      const completed = await h.controller.finishAttempt({
        attemptId: implementation.attemptId,
        outcome: "succeeded",
        artifactPath: implementation.artifactPath,
      });
      assert.equal(completed.replayed, undefined);
      if (!completed.replayed) assert.equal(completed.workflowCompleted, true);
      assert.equal((await h.controller.getRunStatus()).implementations?.s1?.nodeId, "implemented");
      h.setWorkspace({
        root: h.cwd,
        head: "2222222222222222222222222222222222222222",
        clean: true,
        status: "",
      });
      const verifier = await h.controller.startAssignment(undefined, "provider/model");
      assert.equal(verifier.workflow, "verification");
      if (verifier.workflow === "verification") {
        assert.equal(verifier.role, "verify.verifier");
        assert.equal(verifier.implementationArtifactId, completed.artifactId);
        assert.equal(verifier.evaluatedCommit, "2222222222222222222222222222222222222222");
      }
    }
    await h.controller.waitForRecording();
    assert.equal(h.recorder.events.filter((e) => e.type === "attempt.finished").length, 6);
    assert(!h.recorder.events.some((event) => event.type === "run.finished"));
    assert(!JSON.stringify(h.recorder.events).includes("Synthetic objective"));
  } finally {
    await h.cleanup();
  }
});

test("feedback invalidates target and later acceptances while preserving evidence", async () => {
  const h = await setup();
  try {
    await h.produce();
    await h.controller.advanceRun();
    await h.produce();
    await h.controller.advanceRun();
    const previous = await h.controller.getRunStatus();
    await h.produce({
      kind: "feedback",
      reason: "ambiguous_criteria",
      evidence: "Conflicting acceptance examples",
    });
    assert.deepEqual(await h.controller.advanceRun(), { advanced: true, phase: "define" });
    const current = await h.controller.getRunStatus();
    assert.equal(current.run?.accepted?.define, undefined);
    assert.equal(current.run?.accepted?.discovery, previous.run?.accepted?.discovery);
    assert.equal(Object.keys(current.run?.artifacts ?? {}).length, 3);
    const next = await h.controller.startAssignment();
    assert.equal(next.inputArtifacts?.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("human approval is bound to the pending artifact and persists across reload", async () => {
  const h = await setup({ humanGates: ["define"] });
  try {
    await h.produce();
    await h.controller.advanceRun();
    const { result } = await h.produce();
    const gate = await h.controller.advanceRun();
    assert.equal(gate.advanced, false);
    assert.equal(gate.humanArtifactId, result.replayed ? undefined : result.artifactId);
    const restored = await h.restore();
    await assert.rejects(restored.advanceRun("other"), /approval does not match/);
    assert.equal((await restored.advanceRun(gate.humanArtifactId)).phase, "design");
    await restored.waitForRecording();
    assert.equal(h.recorder.events.filter((e) => e.type === "human.approved").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("assignment admission uses the remaining budget after preparing local evidence", async () => {
  const h = await setup({ maxTimeMs: 1000, attemptTimeMs: 1000 });
  try {
    await h.produce();
    await h.controller.advanceRun();
    const readArtifact = h.options.readArtifact;
    let readDuration = 200;
    h.options.readArtifact = async (path) => {
      h.advanceTime(readDuration);
      return readArtifact(path);
    };
    const restored = await h.restore();
    const assignment = await restored.startAssignment();
    assert.equal(assignment.timeoutMs, 800);
    const started = (await restored.getRunStatus()).timeline.find(
      (event) =>
        (event as RecordedEvent).type === "attempt.started" &&
        (event as RecordedEvent).data.attemptId === assignment.attemptId,
    ) as RecordedEvent;
    assert.equal(started.occurredAt, 1200);
    await restored.finishAttempt({ attemptId: assignment.attemptId, outcome: "failed" });
    const before = await restored.getRunStatus();
    readDuration = 1000;
    await assert.rejects(restored.startAssignment(), /time budget exhausted/);
    const after = await restored.getRunStatus();
    assert.deepEqual(after.run, before.run);
  } finally {
    await h.cleanup();
  }
});

test("artifact provenance, seal, and strict contracts protect Pi gates", async () => {
  const h = await setup();
  try {
    const discovery = await h.produce();
    assert(discovery.assignment.artifactPath);
    h.artifacts.set(discovery.assignment.artifactPath, { content: "edited", digest: "changed" });
    const gate = await h.controller.advanceRun();
    assert.equal(gate.advanced, false);
    if (!gate.advanced) assert.match(gate.reason, /changed/);
    h.artifacts.set(discovery.assignment.artifactPath, {
      content: "# Brief\nEvidence",
      digest: "# Brief\nEvidence",
    });
    await h.controller.advanceRun();
    const assignment = await h.controller.startAssignment();
    assert(assignment.artifactPath);
    h.artifacts.set(assignment.artifactPath, {
      content: JSON.stringify({
        schemaVersion: 1,
        inputs: [],
        output: fixtures[0]?.artifact.output,
      }),
      digest: "bad",
    });
    await assert.rejects(
      h.controller.finishAttempt({
        attemptId: assignment.attemptId,
        outcome: "succeeded",
        artifactPath: assignment.artifactPath,
      }),
      /input references/,
    );
    await h.controller.finishAttempt({ attemptId: assignment.attemptId, outcome: "failed" });
    assert.equal(
      (await h.controller.getRunStatus()).run?.attempts[assignment.attemptId]?.outcome,
      "failed",
    );
  } finally {
    await h.cleanup();
  }
});

test("timeout normalization, repeated results, cancellation, and retry stay distinct", async () => {
  const h = await setup({ attemptTimeMs: 10 });
  try {
    const first = await h.controller.startAssignment();
    assert(first.artifactPath);
    h.advanceTime(11);
    const late = await h.controller.finishAttempt({
      attemptId: first.attemptId,
      outcome: "succeeded",
      artifactPath: first.artifactPath,
    });
    assert.equal(late.outcome, "timed_out");
    assert.equal(
      (
        await h.controller.finishAttempt({
          attemptId: first.attemptId,
          outcome: "succeeded",
          artifactPath: first.artifactPath,
        })
      ).replayed,
      true,
    );
    await assert.rejects(
      h.controller.finishAttempt({ attemptId: first.attemptId, outcome: "failed" }),
      /different outcome/,
    );
    await assert.rejects(h.controller.startAssignment(first.assignmentId), /only an interrupted/);
    const cancelled = await h.controller.startAssignment();
    await h.controller.finishAttempt({ attemptId: cancelled.attemptId, outcome: "cancelled" });
    const lost = await h.controller.startAssignment();
    const restored = await h.restore();
    assert.equal(
      (await restored.getRunStatus()).run?.attempts[lost.attemptId]?.outcome,
      "interrupted",
    );
    const retry = await restored.startAssignment(lost.assignmentId);
    assert.notEqual(retry.attemptId, lost.attemptId);
    assert.equal(retry.assignmentId, lost.assignmentId);
  } finally {
    await h.cleanup();
  }
});

test("Pi applies attempt, wall-time, cost reservation and concurrency limits", async () => {
  const cases: Array<{
    policy: WorkflowPolicy;
    finish: boolean;
    advance?: number;
    reason: RegExp;
  }> = [
    { policy: { maxAttempts: 1 }, finish: true, reason: /attempt budget/ },
    {
      policy: { maxTimeMs: 10, attemptTimeMs: 10 },
      finish: true,
      advance: 11,
      reason: /time budget/,
    },
    { policy: { maxCostMicros: 5, attemptCostMicros: 5 }, finish: true, reason: /cost budget/ },
    { policy: { maxConcurrency: 1 }, finish: false, reason: /concurrency budget/ },
  ];
  for (const item of cases) {
    const h = await setup(item.policy);
    try {
      const first = await h.controller.startAssignment();
      if (item.finish)
        await h.controller.finishAttempt({ attemptId: first.attemptId, outcome: "failed" });
      if (item.advance) h.advanceTime(item.advance);
      await assert.rejects(h.controller.startAssignment(), item.reason);
    } finally {
      await h.cleanup();
    }
  }
  for (const policy of [
    { maxAttempts: 0 },
    { attemptTimeMs: 4000000 },
    { maxCostMicros: 10 },
    { humanGates: ["future"] },
  ])
    assert.throws(() => policyFrom(policy));
});

test("rejected input validation leaves no orphan assignment in subsequent checkpoints", async () => {
  const h = await setup();
  try {
    const first = await h.produce();
    await h.controller.advanceRun();
    assert(first.assignment.artifactPath);
    const original = h.artifacts.get(first.assignment.artifactPath);
    assert(original);
    h.artifacts.delete(first.assignment.artifactPath);
    await assert.rejects(h.controller.startAssignment(), /unavailable/);
    h.artifacts.set(first.assignment.artifactPath, original);
    await h.produce();
    const state = (await h.controller.getRunStatus()).run as unknown as {
      assignments: Record<string, unknown>;
    };
    assert.equal(Object.keys(state.assignments).length, 2);
    await h.controller.waitForRecording();
    assert.equal(h.recorder.events.filter((e) => e.type === "assignment.created").length, 2);
  } finally {
    await h.cleanup();
  }
});

test("a pending human gate can replace broken evidence without reusing old approval", async () => {
  const h = await setup({ humanGates: ["define"] });
  try {
    await h.produce();
    await h.controller.advanceRun();
    const first = await h.produce();
    const oldGate = await h.controller.advanceRun();
    assert(first.assignment.artifactPath);
    h.artifacts.delete(first.assignment.artifactPath);
    const blocked = await h.controller.advanceRun();
    assert.equal(blocked.advanced, false);
    await h.produce();
    const gate = await h.controller.advanceRun();
    assert.notEqual(gate.humanArtifactId, oldGate.humanArtifactId);
    await assert.rejects(
      h.controller.advanceRun(oldGate.humanArtifactId),
      /approval does not match/,
    );
    assert.equal((await h.controller.advanceRun(gate.humanArtifactId)).phase, "design");
    await h.produce({
      kind: "feedback",
      reason: "ambiguous_criteria",
      evidence: "Need clarification",
    });
    await assert.rejects(h.controller.advanceRun("unrelated-approval"), /approval does not match/);
    assert.equal((await h.controller.getRunStatus()).run?.visits.at(-1)?.phase, "design");
  } finally {
    await h.cleanup();
  }
});
