import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  RecordedEvent,
  RecordedStatus,
  RecorderClient,
  RoutingSnapshot,
} from "../bridge/xper-client.js";
import { PiWorkflow } from "../workflow/controller.js";
import {
  parseDocument,
  selectImplementationHandoff,
  validateDag,
  validateLinks,
  type Document,
  type Output,
  type PlannedAssignment,
} from "../workflow/contracts.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { policyFrom } from "../workflow/policy.js";
import type { WorkflowPolicy } from "../workflow/types.js";

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../fixtures/knowledge-v1.json", import.meta.url)),
    "utf8",
  ),
) as Array<{ phase: string; artifact: Document }>;
class Recorder implements RecorderClient {
  events: RecordedEvent[] = [];
  offline = false;
  volatile = false;
  routing: RoutingSnapshot | null = null;
  config: WorkflowPolicy = {};
  async appendEvents(events: RecordedEvent[]) {
    if (this.offline) throw new Error("offline");
    let accepted = 0;
    for (const event of events) {
      const existing = this.events.find((e) => e.eventId === event.eventId);
      if (existing) {
        assert.deepEqual(existing, event);
        continue;
      }
      this.events.push(structuredClone(event));
      accepted++;
    }
    return {
      accepted,
      durability: this.volatile ? ("volatile" as const) : ("persistent" as const),
    };
  }
  async getRunStatus(): Promise<RecordedStatus> {
    if (this.offline) throw new Error("offline");
    return {
      run: this.events.length ? { runId: this.events[0]?.runId } : null,
      timeline: structuredClone(this.events),
      durability: "persistent",
    };
  }
  async inspectProfile() {
    return this.routing;
  }
  async resolveConfiguration() {
    return { routing: this.routing, adapterConfig: { ...this.config } };
  }
}
async function setup(policy: WorkflowPolicy = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "xper-pi-policy-"));
  const recorder = new Recorder();
  recorder.config = policy;
  const artifacts = new Map<string, { content: string; digest: string }>();
  let now = 1000;
  let workspace = {
    root: cwd,
    head: "1111111111111111111111111111111111111111",
    clean: true,
    status: "",
  };
  const options = {
    configuration: () => ({ routing: recorder.routing, adapterConfig: { ...recorder.config } }),
    now: () => now,
    readArtifact: async (path: string) => {
      const result = artifacts.get(path);
      if (!result) throw new Error("artifact unavailable");
      return result;
    },
    inspectWorkspace: async () => structuredClone(workspace),
  };
  const controller = new PiWorkflow(recorder, cwd, "session", options);
  const controllers = [controller];
  const produce = async (output?: Output) => {
    const assignment = await controller.startAssignment();
    assert(assignment.artifactPath);
    const content =
      assignment.phase === "discovery"
        ? "# Brief\nEvidence"
        : JSON.stringify({
            schemaVersion: 1,
            inputs: assignment.inputArtifacts?.map((a) => a.artifact_id),
            output: output ?? fixtures.find((f) => f.phase === assignment.phase)?.artifact.output,
          });
    artifacts.set(assignment.artifactPath, { content, digest: content });
    const result = await controller.finishAttempt({
      attemptId: assignment.attemptId,
      outcome: "succeeded",
      artifactPath: assignment.artifactPath,
    });
    return { assignment, result };
  };
  await controller.startRun("Synthetic objective");
  return {
    cwd,
    recorder,
    controller,
    artifacts,
    options,
    produce,
    advanceTime: (ms: number) => {
      now += ms;
    },
    setWorkspace: (next: typeof workspace) => {
      workspace = structuredClone(next);
    },
    restore: async () => {
      for (const previous of controllers) {
        await previous.waitForRecording();
        previous.stopRecording();
      }
      const restored = new PiWorkflow(recorder, cwd, "session", options);
      controllers.push(restored);
      return restored;
    },
    cleanup: async () => {
      for (const workflow of controllers) {
        await workflow.waitForRecording();
        workflow.stopRecording();
      }
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function sealPlan(harness: Awaited<ReturnType<typeof setup>>, plan?: Output) {
  let planPath = "";
  for (const phase of ["discovery", "define", "design", "breakdown", "plan"]) {
    const produced = await harness.produce(phase === "plan" ? plan : undefined);
    planPath = produced.assignment.artifactPath ?? planPath;
    const gate = await harness.controller.advanceRun();
    assert(gate.advanced);
  }
  return planPath;
}

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
      await assert.rejects(h.controller.startAssignment(undefined, "provider/model"), /Verifier/);
    }
    await h.controller.waitForRecording();
    assert.equal(h.recorder.events.filter((e) => e.type === "attempt.finished").length, 6);
    assert(!h.recorder.events.some((event) => event.type === "run.finished"));
    assert(!JSON.stringify(h.recorder.events).includes("Synthetic objective"));
  } finally {
    await h.cleanup();
  }
});

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
test("DAG validation rejects references, cycles and unordered workspace or resource conflicts", () => {
  for (const nodes of [
    [],
    [{ id: "a", dependencies: ["missing"] }],
    [
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["a"] },
    ],
    [
      { id: "a", dependencies: [] },
      { id: "a", dependencies: [] },
    ],
    [
      { id: "a", dependencies: [], workspace: "same" },
      { id: "b", dependencies: [], workspace: "same" },
    ],
    [
      { id: "a", dependencies: [], resources: ["integration"] },
      { id: "b", dependencies: [], resources: ["integration"] },
    ],
  ])
    assert.throws(() => validateDag(nodes));
  assert.deepEqual(
    [
      ...validateDag([
        { id: "a", dependencies: [], workspace: "same" },
        { id: "b", dependencies: ["a"], workspace: "same" },
      ]).keys(),
    ],
    ["a", "b"],
  );
});
test("story coverage, verifier ordering, dependent increments and Plan budgets are enforced", () => {
  const definition = fixtures.find((f) => f.phase === "define")?.artifact;
  const breakdown = fixtures.find((f) => f.phase === "breakdown")?.artifact;
  const plan = fixtures.find((f) => f.phase === "plan")?.artifact;
  assert(definition && breakdown && plan);
  assert.equal(plan.output.kind, "execution_plan");
  const budget = { attempts: 32, timeMs: 3600000, costMicros: null, concurrency: 4 };
  const upstream = { define: definition, breakdown };
  validateLinks(breakdown.output, upstream, budget);
  validateLinks(plan.output, upstream, budget);
  if (breakdown.output.kind !== "story_map" || plan.output.kind !== "execution_plan") assert.fail();
  assert.deepEqual(
    plan.output.assignments.map((assignment) => assignment.role),
    ["implementation.driver", "verify.verifier"],
  );
  const unsupported = structuredClone(plan);
  assert(unsupported.output.kind === "execution_plan");
  const implementer = unsupported.output.assignments[0];
  assert(implementer);
  implementer.role = "implementation.reviewer";
  assert.throws(
    () => parseDocument(JSON.stringify(unsupported), unsupported.inputs),
    /delivery role/,
  );
  const uncovered = structuredClone(breakdown.output);
  uncovered.stories[0]?.criteria.push("unknown");
  assert.throws(() => validateLinks(uncovered, upstream, budget), /cover every/);
  const invalidOrder = structuredClone(plan.output);
  const verifier = invalidOrder.assignments.find((a) => a.role === "verify.verifier");
  assert(verifier);
  verifier.dependencies = [];
  // Give independent workspaces so the verifier-specific order check is reached.
  for (const a of invalidOrder.assignments) a.workspace = a.id;
  assert.throws(() => validateLinks(invalidOrder, upstream, budget), /verification must depend/);
  assert.throws(() => validateLinks(plan.output, upstream, { ...budget, attempts: 1 }), /exceeds/);
  const missing = structuredClone(plan.output);
  missing.assignments = missing.assignments.filter((a) => a.role !== "verify.verifier");
  assert.throws(() => validateLinks(missing, upstream, budget), /one implementer/);
  const stories = structuredClone(breakdown);
  assert(stories.output.kind === "story_map");
  const first = stories.output.stories[0];
  assert(first);
  stories.output.stories.push({ ...first, id: "dependent", dependencies: [first.id] });
  const dependent = structuredClone(plan.output);
  dependent.assignments.push(
    ...plan.output.assignments.map(
      (a): PlannedAssignment => ({
        ...a,
        id: `dep-${a.id}`,
        incrementId: "dependent",
        dependencies: a.dependencies.map((d) => `dep-${d}`),
        workspace: `dep-${a.workspace}`,
      }),
    ),
  );
  assert.throws(
    () => validateLinks(dependent, { ...upstream, breakdown: stories }, budget),
    /increment dependency/,
  );
  assert.throws(
    () => parseDocument(JSON.stringify({ ...definition, extra: true }), definition.inputs),
    /structured/,
  );
});

test("implementation handoff follows sealed Plan order and requires the frozen route", () => {
  const definitionFixture = fixtures.find((fixture) => fixture.phase === "define")?.artifact;
  const breakdownFixture = fixtures.find((fixture) => fixture.phase === "breakdown")?.artifact;
  const planFixture = fixtures.find((fixture) => fixture.phase === "plan")?.artifact;
  assert(definitionFixture && breakdownFixture && planFixture);
  const definition = structuredClone(definitionFixture);
  const breakdown = structuredClone(breakdownFixture);
  const plan = structuredClone(planFixture);
  assert(definition?.output.kind === "definition_contract");
  assert(breakdown?.output.kind === "story_map");
  assert(plan?.output.kind === "execution_plan");
  definition.output.criteria.push({ id: "c2", behavior: "Second", example: "Two" });
  breakdown.output.stories.push({
    id: "s2",
    value: "Second increment",
    criteria: ["c2"],
    verification: ["verify second"],
    independentlyVerifiable: true,
    dependencies: [],
  });
  const [driver, verifier] = plan.output.assignments;
  assert(driver && verifier);
  plan.output.assignments = [
    { ...driver, id: "driver-2", incrementId: "s2", workspace: "s2" },
    {
      ...verifier,
      id: "verifier-2",
      incrementId: "s2",
      dependencies: ["driver-2"],
      workspace: "s2",
    },
    driver,
    verifier,
  ];
  const upstream = { define: definition, breakdown };
  const budget = { attempts: 32, timeMs: 3_600_000, costMicros: null, concurrency: 4 };
  validateLinks(plan.output, upstream, budget);
  const routing = {
    profile: "delivery",
    context: "local",
    routes: {
      "implementation.driver": [
        {
          context: "local",
          provider: "synthetic",
          model: "implementer",
          thinking: "medium",
        },
      ],
    },
  };
  assert.equal(selectImplementationHandoff(plan.output, upstream, routing).incrementId, "s2");
  assert.throws(
    () => selectImplementationHandoff(plan.output, upstream, { ...routing, routes: {} }),
    /no implementation.driver route/,
  );
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
