import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiWorkflow } from "../workflow/controller.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { fixtures, Recorder, sealPlan, setup } from "./workflow-harness.js";

test("implementation settlement, retry, status and recovery do not await Rust", {
  timeout: 5000,
}, async () => {
  const h = await setup();
  let restored: PiWorkflow | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const fixturePlan = fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output;
    assert(fixturePlan?.kind === "execution_plan");
    const plan = structuredClone(fixturePlan);
    const driver = plan.assignments.find(
      (assignment) => assignment.role === "implementation.driver",
    );
    assert(driver);
    driver.maxAttempts = 3;
    await sealPlan(h, plan);
    await h.controller.waitForRecording();
    const append = h.recorder.appendEvents.bind(h.recorder);
    h.recorder.appendEvents = async (events) => {
      await held;
      return append(events);
    };
    const beforeTimeout = async <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([
        operation,
        new Promise<T>((_resolve, reject) =>
          setTimeout(() => reject(new Error("local operation awaited Rust")), 250),
        ),
      ]);
    const first = await beforeTimeout(
      h.controller.startAssignment(undefined, "provider/frozen-model"),
    );
    await beforeTimeout(
      h.controller.finishAttempt({ attemptId: first.attemptId, outcome: "failed" }),
    );
    const second = await beforeTimeout(h.controller.startAssignment());
    assert.equal(second.workflow, "implementation");
    await beforeTimeout(h.controller.getRunStatus());
    await beforeTimeout(h.controller.stopRecording());
    restored = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
    await beforeTimeout(restored.getRunStatus());
    await assert.rejects(beforeTimeout(restored.startAssignment()), /retry interrupted/);
    const third = await beforeTimeout(restored.startAssignment("driver"));
    assert.equal(third.workflow, "implementation");
  } finally {
    release();
    await restored?.stopRecording();
    await h.cleanup();
  }
});

test("recorder loss cannot stop Pi; pending facts replay idempotently after reload", async () => {
  const h = await setup();
  try {
    h.recorder.offline = true;
    await h.produce();
    assert.equal((await h.controller.advanceRun()).phase, "define");
    await h.controller.waitForRecording();
    assert.match((await h.controller.getRunStatus()).degradedReason ?? "", /pending/);
    const restored = await h.restore();
    assert.equal((await restored.getRunStatus()).run?.visits.at(-1)?.phase, "define");
    h.recorder.offline = false;
    await restored.waitForRecording();
    assert.equal((await restored.getRunStatus()).degradedReason, undefined);
    const count = h.recorder.events.length;
    await restored.getRunStatus();
    assert.equal(h.recorder.events.length, count);
    await h.controller.waitForRecording();
    assert.equal(h.recorder.events.filter((e) => e.type === "attempt.finished").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("volatile ACKs and local disk failure never manufacture persistent telemetry", async () => {
  const h = await setup();
  try {
    h.recorder.volatile = true;
    await h.produce();
    await h.controller.waitForRecording();
    assert.match((await h.controller.getRunStatus()).degradedReason ?? "", /volatile/);
    h.recorder.volatile = false;
    await h.controller.getRunStatus();
    const blocked = join(h.cwd, "not-a-directory");
    await writeFile(blocked, "file");
    const journal = new WorkflowJournal(blocked, "session", h.recorder);
    h.recorder.offline = true;
    await journal.commit({ state: true }, [
      { schemaVersion: 1, eventId: "pending", runId: "r", occurredAt: 1, type: "custom", data: {} },
    ]);
    await journal.waitForIdle();
    journal.stop();
    assert.equal(journal.pending.length, 1);
    assert.match(journal.problem ?? "", /held in memory/);
  } finally {
    await h.cleanup();
  }
});

test("lost ACK keeps exact event identities and deduplicates after reconnect", async () => {
  const h = await setup();
  try {
    const original = h.recorder.appendEvents.bind(h.recorder);
    let lose = true;
    h.recorder.appendEvents = async (events) => {
      const result = await original(events);
      if (lose) throw new Error("ACK lost");
      return result;
    };
    await h.produce();
    await h.controller.waitForRecording();
    const count = h.recorder.events.length;
    lose = false;
    await h.controller.waitForRecording();
    assert.equal(h.recorder.events.length, count);
  } finally {
    await h.cleanup();
  }
});

test("recorder history is observational and cannot choose or prevent a new Pi run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-legacy-pi-"));
  const recorder = new Recorder();
  recorder.getRunStatus = async () => {
    throw new Error("must not query execution state");
  };
  recorder.resolveConfiguration = async () => {
    throw new Error("must not resolve on execution path");
  };
  recorder.inspectProfile = async () => {
    throw new Error("must not inspect on execution path");
  };
  const controller = new PiWorkflow(recorder, cwd, "session");
  try {
    assert.equal((await controller.getRunStatus()).run, null);
    assert.equal(await controller.inspectProfile(), null);
    assert.equal((await controller.startRun("Local workflow")).resumed, false);
    await controller.startAssignment();
    await controller.waitForRecording();
  } finally {
    controller.stopRecording();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("large checkpoints stay below event limits while execution resumes from local state", async () => {
  const h = await setup({ maxAttempts: 150 });
  try {
    for (let i = 0; i < 55; i++) {
      const attempt = await h.controller.startAssignment();
      await h.controller.finishAttempt({ attemptId: attempt.attemptId, outcome: "failed" });
    }
    await h.controller.waitForRecording();
    assert(h.recorder.events.some((e) => e.type === "adapter.state.chunk"));
    assert(h.recorder.events.every((e) => Buffer.byteLength(JSON.stringify(e)) < 40000));
    const restored = await h.restore();
    assert.equal(Object.keys((await restored.getRunStatus()).run?.attempts ?? {}).length, 55);
  } finally {
    await h.cleanup();
  }
});

test("cold start, decisions and local recovery complete while every Rust RPC is pending", {
  timeout: 5000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-hung-telemetry-"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = new Recorder();
  const append = recorder.appendEvents.bind(recorder);
  let appendCalls = 0;
  recorder.appendEvents = async (events) => {
    appendCalls++;
    await held;
    return append(events);
  };
  recorder.getRunStatus = async () => {
    await held;
    throw new Error("unexpected query");
  };
  recorder.resolveConfiguration = async () => {
    await held;
    throw new Error("unexpected resolution");
  };
  recorder.inspectProfile = async () => {
    await held;
    throw new Error("unexpected inspection");
  };
  const options = {
    now: () => 1000,
    configuration: () => ({ routing: null, adapterConfig: { attemptTimeMs: 100 } }),
    readArtifact: async () => ({ content: "Evidence", digest: "sealed" }),
  };
  const controller = new PiWorkflow(recorder, cwd, "session", options);
  let restored: PiWorkflow | undefined;
  try {
    const started = await controller.startRun("Offline first run");
    const assignment = await controller.startAssignment();
    assert(assignment.artifactPath);
    await controller.recordUsage(assignment.attemptId, { inputTokens: 2 });
    const result = await controller.finishAttempt({
      attemptId: assignment.attemptId,
      outcome: "succeeded",
      artifactPath: assignment.artifactPath,
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal((await controller.advanceRun()).phase, "define");
    assert(appendCalls > 0);
    assert.equal(recorder.events.length, 0);
    controller.stopRecording();
    restored = new PiWorkflow(recorder, cwd, "session", options);
    assert.equal((await restored.startRun("Resume without Rust")).runId, started.runId);
    assert.equal((await restored.getRunStatus()).run?.visits.at(-1)?.phase, "define");
    assert.equal((await restored.startAssignment()).phase, "define");
  } finally {
    release();
    await controller.waitForRecording();
    await restored?.waitForRecording();
    controller.stopRecording();
    restored?.stopRecording();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a prepared configuration is frozen even when later preparation changes", async () => {
  const h = await setup();
  try {
    h.recorder.routing = { profile: "later", context: "new", routes: {} };
    h.recorder.config = { maxAttempts: 1 };
    assert.equal(await h.controller.inspectProfile(), null);
    const a = await h.controller.startAssignment();
    assert.equal(a.selection, null);
    await h.controller.finishAttempt({ attemptId: a.attemptId, outcome: "failed" });
    await h.controller.startAssignment();
    assert.equal(await h.controller.inspectProfile(), null);
  } finally {
    await h.cleanup();
  }
});

test("stopping preserves already queued local usage without awaiting recording", async () => {
  const h = await setup();
  try {
    const attempt = await h.controller.startAssignment();
    const usage = h.controller.recordUsage(attempt.attemptId, { inputTokens: 17 });
    await h.controller.stopRecording();
    await usage;
    const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
    await journal.load();
    assert(
      journal.pending.some(
        (event) => event.type === "model.usage" && event.data.inputTokens === 17,
      ),
    );
    await journal.close();
    await assert.rejects(h.controller.startAssignment(), /stopped/);
  } finally {
    await h.cleanup();
  }
});
