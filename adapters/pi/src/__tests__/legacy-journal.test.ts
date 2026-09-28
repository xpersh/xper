import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { object, type RecordedEvent, type RecorderClient } from "../bridge/xper-client.js";
import { PiWorkflow } from "../workflow/controller.js";
import { type JournalData, WorkflowJournal } from "../workflow/journal.js";
import { policyFrom } from "../workflow/policy.js";
import { decodeCheckpoint } from "../workflow/state.js";
import { WorkflowValidationError } from "../workflow/types.js";

function legacyState(active = false) {
  return {
    version: 1,
    revision: 4,
    run_id: "historical-run",
    startedAt: 1_000,
    routing: null,
    policy: policyFrom({ maxAttempts: 5, maxTimeMs: 60_000, attemptTimeMs: 10_000 }),
    visits: [{ id: "historical-visit", phase: "discovery" }],
    assignments: {
      "historical-assignment": {
        id: "historical-assignment",
        visitId: "historical-visit",
        phase: "discovery",
        role: "discovery.explorer",
        inputs: [],
        selection: null,
        attemptIds: ["historical-attempt"],
      },
    },
    attempts: {
      "historical-attempt": {
        assignmentId: "historical-assignment",
        startedAt: 1_100,
        timeoutMs: 10_000,
        outcome: active ? null : "failed",
        artifactId: null,
        artifactPath: ".xper/artifacts/discovery-historical-attempt.md",
        selection: null,
      },
    },
    artifacts: {},
    accepted: {},
    feedback: null,
    human_input: null,
    ready: false,
  };
}

const historicalEvents: RecordedEvent[] = [
  {
    schemaVersion: 1,
    eventId: "historical-event-1",
    runId: "historical-run",
    occurredAt: 1_000,
    type: "run.started",
    data: { objectiveHash: "historical-objective-hash" },
  },
  {
    schemaVersion: 1,
    eventId: "historical-event-2",
    runId: "historical-run",
    occurredAt: 1_100,
    type: "attempt.started",
    data: { attemptId: "historical-attempt", selection: null },
  },
];

async function beforeTimeout<T>(operation: Promise<T>): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(2_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("legacy checkpoint operation waited for Rust");
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

async function setup(t: TestContext, state: unknown = legacyState()) {
  const directory = await mkdtemp(join(tmpdir(), "xper-legacy-journal-"));
  const controllers: PiWorkflow[] = [];
  let sequence = 0;
  let calls = 0;
  let beginDelivery!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => {
    beginDelivery = resolve;
  });
  const sent: RecordedEvent[][] = [];
  const recorder: Pick<RecorderClient, "appendEvents"> = {
    appendEvents(events) {
      calls++;
      sent.push(structuredClone(events));
      beginDelivery();
      return new Promise(() => {});
    },
  };
  const path = new WorkflowJournal(directory, "historical-session", recorder).path;
  const original = JSON.stringify({
    version: 1,
    state,
    pending: historicalEvents,
  } satisfies JournalData);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, original);
  const open = () => {
    const controller = new PiWorkflow(recorder, directory, "historical-session", {
      now: () => 2_000,
      id: () => `new-identity-${++sequence}`,
      configuration: () => assert.fail("recovery must use its frozen configuration"),
      readArtifact: async () =>
        assert.fail("checkpoint recovery must not execute or read artifacts"),
    });
    controllers.push(controller);
    return controller;
  };
  t.after(async () => {
    await beforeTimeout(Promise.all(controllers.map((controller) => controller.stopRecording())));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    open,
    original,
    sent,
    deliveryStarted,
    calls: () => calls,
    bytes: () => readFile(path, "utf8"),
    snapshot: async (): Promise<JournalData> => JSON.parse(await readFile(path, "utf8")),
  };
}

test("legacy status migrates locally without rewriting pending identities or waiting for Rust", async (t) => {
  const h = await setup(t);
  const controller = h.open();
  const status = await beforeTimeout(controller.getRunStatus());
  assert.equal(status.run?.run_id, "historical-run");
  assert.equal(status.workflow?.instanceId, "historical-run");
  assert.deepEqual(status.timeline, historicalEvents);
  assert.match(status.degradedReason ?? "", /pending/);
  await beforeTimeout(h.deliveryStarted);
  assert.deepEqual(h.sent[0], historicalEvents);
  assert.equal(await h.bytes(), h.original);
  assert.deepEqual((await beforeTimeout(controller.getRunStatus())).timeline, historicalEvents);
});

test("the next local transition persists migrated state while retaining the historical outbox", async (t) => {
  const h = await setup(t);
  const controller = h.open();
  await beforeTimeout(controller.getRunStatus());
  await beforeTimeout(h.deliveryStarted);
  const assignment = await beforeTimeout(controller.startAssignment());
  assert.equal(assignment.phase, "discovery");
  const snapshot = await h.snapshot();
  assert(object(snapshot.state));
  assert.equal(snapshot.state.version, 2);
  assert.equal(snapshot.state.instanceId, "historical-run");
  assert.deepEqual(snapshot.pending.slice(0, historicalEvents.length), historicalEvents);
  assert.equal(
    new Set(snapshot.pending.map((event) => event.eventId)).size,
    snapshot.pending.length,
  );
  const checkpoint = snapshot.pending.find((event) => event.type === "adapter.state");
  assert(checkpoint);
  assert.deepEqual(checkpoint.data.state, snapshot.state);
  const state = decodeCheckpoint(snapshot.state);
  assert.equal(state?.attempts[assignment.attemptId]?.outcome, null);
  assert.equal(state?.attempts["historical-attempt"]?.outcome, "failed");
});

test("legacy recovery interrupts an active attempt once and never admits execution automatically", async (t) => {
  const h = await setup(t, legacyState(true));
  const first = h.open();
  const recovered = await beforeTimeout(first.getRunStatus());
  await beforeTimeout(h.deliveryStarted);
  const snapshot = await h.snapshot();
  const state = decodeCheckpoint(snapshot.state);
  assert(object(snapshot.state));
  assert.equal(snapshot.state.version, 2);
  assert.equal(state?.attempts["historical-attempt"]?.outcome, "interrupted");
  assert.deepEqual(Object.keys(state?.assignments ?? {}), ["historical-assignment"]);
  assert.deepEqual(Object.keys(state?.attempts ?? {}), ["historical-attempt"]);
  const settlement = snapshot.pending.filter((event) => event.type === "attempt.finished");
  assert.equal(settlement.length, 1);
  assert.equal(settlement[0]?.data.attemptId, "historical-attempt");
  assert.equal(settlement[0]?.data.outcome, "interrupted");
  assert(
    !snapshot.pending
      .slice(historicalEvents.length)
      .some((event) => event.type === "assignment.created" || event.type === "attempt.started"),
  );
  await beforeTimeout(first.stopRecording());
  const savedBytes = await h.bytes();
  const restored = await beforeTimeout(h.open().getRunStatus());
  assert.deepEqual(restored.run, recovered.run);
  assert.deepEqual(restored.timeline, recovered.timeline);
  assert.equal(
    restored.timeline.filter((event) => object(event) && event.type === "attempt.finished").length,
    1,
  );
  assert.equal(await h.bytes(), savedBytes);
});

test("unsupported checkpoints reject recovery without modifying the journal or sending pending events", async (t) => {
  const valid = decodeCheckpoint(legacyState());
  assert(valid);
  for (const state of [
    { ...valid, version: 99 },
    { ...valid, definition: { id: "pi.knowledge", version: 99 } },
  ]) {
    const h = await setup(t, state);
    const controller = h.open();
    await assert.rejects(beforeTimeout(controller.getRunStatus()), WorkflowValidationError);
    await assert.rejects(
      beforeTimeout(controller.startRun("must preserve history")),
      WorkflowValidationError,
    );
    assert.equal(await h.bytes(), h.original);
    assert.equal(h.calls(), 0);
  }
});
