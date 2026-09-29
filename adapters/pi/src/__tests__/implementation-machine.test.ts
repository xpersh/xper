import assert from "node:assert/strict";
import test from "node:test";
import { findTransition, implementationDefinition } from "../workflow/definition.js";
import {
  decodeImplementationState,
  transitionImplementation,
  type ImplementationEvent,
  type ImplementationState,
} from "../workflow/implementation.js";

const base = "1111111111111111111111111111111111111111";
const resultCommit = "2222222222222222222222222222222222222222";
const artifactPath = ".xper/artifacts/implementation-result-t1.json";

function startEvent(
  attemptId = "t1",
  assignmentId?: string,
): Extract<ImplementationEvent, { type: "assignment.start" }> {
  return {
    type: "assignment.start",
    runId: "run",
    instanceId: "implementation-s1",
    attemptId,
    ...(assignmentId ? { assignmentId } : {}),
    planArtifactId: "plan",
    planDigest: "sealed-plan",
    assignment: {
      id: "driver",
      incrementId: "s1",
      role: "implementation.driver",
      dependencies: [],
      workspace: "s1",
      resources: [],
      maxAttempts: 3,
      maxTimeMs: 1_000,
      maxCostMicros: 0,
    },
    inputs: ["brief", "definition", "design", "breakdown", "plan"],
    inputArtifacts: [
      { artifact_id: "plan", kind: "execution_plan", path: "plan.json", version: 1 },
    ],
    criteria: [{ id: "c1", behavior: "Works", example: "Observed" }],
    verification: ["run the focused test"],
    selection: null,
    model: "synthetic/model",
    baseCommit: base,
    attemptTimeMs: 500,
    attemptCostMicros: 0,
    globalBudget: { attempts: 10, timeMs: 10_000, costMicros: null, concurrency: 1 },
  };
}

function report(exitCode = 0, attemptId = "t1") {
  return {
    content: JSON.stringify({
      schemaVersion: 1,
      inputs: ["brief", "definition", "design", "breakdown", "plan"],
      output: {
        kind: "implementation_result",
        assignmentId: "driver",
        incrementId: "s1",
        baseCommit: base,
        resultingCommit: resultCommit,
        changedFiles: ["src/change.ts"],
        tests: [
          {
            command: "npm test",
            exitCode,
            outputPath: `.xper/artifacts/test-output-${attemptId}-1.log`,
          },
        ],
        criteria: [{ criterionId: "c1", evidence: "Focused test", paths: ["src/change.ts"] }],
      },
    }),
    digest: `digest-${attemptId}`,
  };
}

test("implementation definition is separate and a passing host result completes only its instance", () => {
  assert.equal(implementationDefinition.id, "pi.implementation");
  assert.deepEqual(
    implementationDefinition.nodes.map((node) => node.id),
    ["implement", "implemented"],
  );
  const started = transitionImplementation(null, startEvent(), 100);
  assert.equal(started.result.workflow, "implementation");
  assert.equal(started.result.model, "synthetic/model");
  assert.equal(started.result.timeoutMs, 500);
  const finished = transitionImplementation(
    started.state,
    {
      type: "attempt.finish",
      result: { attemptId: "t1", outcome: "succeeded", artifactPath },
      artifactId: "implementation-result",
      evidence: report(),
    },
    200,
  );
  assert.deepEqual(finished.state.lifecycle, {
    status: "completed",
    artifactId: "implementation-result",
  });
  assert.equal(finished.result.replayed, undefined);
  if (!finished.result.replayed) assert.equal(finished.result.workflowCompleted, true);
  const transition = finished.facts.find((fact) => fact.type === "workflow.transition");
  assert(transition);
  assert.equal(
    findTransition(implementationDefinition, "implement", String(transition.data.transitionId))?.to,
    "implemented",
  );
  assert(!finished.facts.some((fact) => fact.type === "run.finished"));
});

test("a failing observed test is retained without completing the implementation gate", () => {
  const started = transitionImplementation(null, startEvent(), 100);
  const failed = transitionImplementation(
    started.state,
    {
      type: "attempt.finish",
      result: { attemptId: "t1", outcome: "failed", artifactPath },
      artifactId: "failed-result",
      evidence: report(1),
    },
    200,
  );
  assert.equal(failed.result.outcome, "failed");
  assert.equal(failed.result.replayed, undefined);
  if (!failed.result.replayed) assert.equal(failed.result.artifactId, "failed-result");
  assert.deepEqual(failed.state.lifecycle, { status: "active" });
  assert(!failed.facts.some((fact) => fact.type === "gate.passed"));
  assert.throws(
    () =>
      transitionImplementation(
        started.state,
        {
          type: "attempt.finish",
          result: { attemptId: "t1", outcome: "succeeded", artifactPath },
          artifactId: "claimed-result",
          evidence: report(1),
        },
        200,
      ),
    /tests did not pass/,
  );
});

test("recovery preserves work, interrupts once, and requires an explicit retry identity", () => {
  const started = transitionImplementation(null, startEvent(), 100);
  const recovered = transitionImplementation(started.state, { type: "session.recover" }, 150);
  assert.equal(recovered.state.attempts.t1?.outcome, "interrupted");
  assert.equal(recovered.facts.filter((fact) => fact.type === "attempt.finished").length, 1);
  const secondRecovery = transitionImplementation(
    recovered.state,
    { type: "session.recover" },
    160,
  );
  assert.equal(secondRecovery.facts.length, 0);
  assert.throws(
    () => transitionImplementation(recovered.state, startEvent("t2"), 170),
    /retry interrupted assignment driver explicitly/,
  );
  const retry = transitionImplementation(recovered.state, startEvent("t2", "driver"), 170);
  assert.deepEqual(retry.state.assignment.attemptIds, ["t1", "t2"]);
  assert.equal(retry.state.baseCommit, base);
});

test("overlap and per-assignment attempt limits are enforced by the pure transition", () => {
  const started = transitionImplementation(null, startEvent(), 100);
  assert.throws(
    () => transitionImplementation(started.state, startEvent("overlap"), 110),
    /already running/,
  );
  let state: ImplementationState = transitionImplementation(
    started.state,
    {
      type: "attempt.finish",
      result: { attemptId: "t1", outcome: "failed", artifactPath },
      artifactId: "failed-one",
      evidence: report(1),
    },
    120,
  ).state;
  for (const id of ["t2", "t3"]) {
    const next = transitionImplementation(state, startEvent(id), 130);
    state = transitionImplementation(
      next.state,
      { type: "attempt.finish", result: { attemptId: id, outcome: "failed" }, artifactId: id },
      140,
    ).state;
  }
  assert.throws(
    () => transitionImplementation(state, startEvent("t4"), 150),
    /attempt budget exhausted/,
  );
});

test("assignment time and cost limits remain cumulative across retries", () => {
  const firstEvent = startEvent();
  firstEvent.assignment.maxAttempts = 3;
  firstEvent.assignment.maxTimeMs = 1_000;
  firstEvent.assignment.maxCostMicros = 10;
  firstEvent.attemptCostMicros = 5;
  firstEvent.globalBudget.costMicros = 10;
  const first = transitionImplementation(null, firstEvent, 100);
  assert.equal(first.result.budget?.costMicros, 5);
  const failed = transitionImplementation(
    first.state,
    {
      type: "attempt.finish",
      result: { attemptId: "t1", outcome: "failed" },
      artifactId: "unused",
    },
    200,
  );
  const secondEvent = startEvent("t2");
  secondEvent.assignment = firstEvent.assignment;
  secondEvent.attemptCostMicros = 5;
  secondEvent.globalBudget.costMicros = 5;
  const second = transitionImplementation(failed.state, secondEvent, 800);
  assert.equal(second.result.timeoutMs, 300);
  assert.equal(second.result.budget?.costMicros, 0);
  const secondFailed = transitionImplementation(
    second.state,
    {
      type: "attempt.finish",
      result: { attemptId: "t2", outcome: "failed" },
      artifactId: "unused-2",
    },
    850,
  );
  assert.throws(
    () => transitionImplementation(secondFailed.state, startEvent("t3"), 900),
    /cost budget exhausted/,
  );
  const timeEvent = startEvent("t3");
  timeEvent.assignment = firstEvent.assignment;
  timeEvent.attemptCostMicros = 0;
  assert.throws(
    () => transitionImplementation(secondFailed.state, timeEvent, 1_100),
    /time budget exhausted/,
  );
});

test("implementation checkpoint decoding rejects incompatible definitions and broken references", () => {
  const started = transitionImplementation(null, startEvent(), 100).state;
  assert.deepEqual(decodeImplementationState(started), started);
  assert.throws(
    () =>
      decodeImplementationState({
        ...started,
        definition: { id: "pi.implementation", version: 2 },
      }),
    /unsupported implementation checkpoint/,
  );
  assert.throws(
    () =>
      decodeImplementationState({
        ...started,
        assignment: { ...started.assignment, attemptIds: ["missing"] },
      }),
    /checkpoint references/,
  );
});
