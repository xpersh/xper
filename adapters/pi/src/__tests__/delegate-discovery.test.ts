import { WorkflowValidationError } from "../workflow/types.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  delegateKnowledge,
  type DelegateKnowledgeRequest,
  type KnowledgeDependencies,
  type KnowledgeExecution,
  type KnowledgeExecutionResult,
} from "../actions/delegate-knowledge.js";
import type { FinishAttempt, ModelSelection, RunAdvanced } from "../workflow/types.js";

function fixture() {
  const calls: string[] = [];
  const executions: KnowledgeExecution[] = [];
  const completions: FinishAttempt[] = [];
  const observations: unknown[] = [];
  const saved: Array<{ cwd: string; attemptId: string; brief: string }> = [];
  const assignmentIds: Array<string | undefined> = [];
  const controller = new AbortController();
  const request: DelegateKnowledgeRequest = {
    task: "Inspect this project",
    cwd: "/workspace",
    signal: controller.signal,
  };
  const state: {
    execution: KnowledgeExecutionResult;
    advance: RunAdvanced;
    failure?: "start" | "execute" | "save" | "finish" | "advance";
  } = {
    execution: { outcome: "succeeded", brief: "# Discovery Brief\nEvidence" },
    advance: { advanced: true, phase: "define" },
  };
  const failure = new Error("dependency unavailable");
  function step(name: typeof state.failure) {
    assert(name);
    calls.push(name);
    if (state.failure === name) throw failure;
  }
  const dependencies: KnowledgeDependencies = {
    workflow: {
      async startAssignment(assignmentId) {
        step("start");
        assignmentIds.push(assignmentId);
        return {
          runId: "run-1",
          assignmentId: assignmentId ?? "assignment-1",
          attemptId: "attempt-1",
          role: "discovery.explorer",
          selection: null,
        };
      },
      async finishAttempt(completion) {
        completions.push(completion);
        step("finish");
        return {
          attemptId: completion.attemptId,
          outcome: completion.outcome,
          artifactId: completion.outcome === "succeeded" ? "artifact-1" : null,
        };
      },
      async advanceRun() {
        step("advance");
        return state.advance;
      },
    },
    async execute(execution) {
      step("execute");
      executions.push(execution);
      return state.execution;
    },
    async saveBrief(cwd, attemptId, brief) {
      step("save");
      saved.push({ cwd, attemptId, brief });
      return `.xper/artifacts/discovery-brief-${attemptId}.md`;
    },
    observe: (event) => observations.push(event),
  };
  return {
    dependencies,
    request,
    state,
    calls,
    executions,
    completions,
    observations,
    saved,
    assignmentIds,
    controller,
    failure,
  };
}

test("delegation saves evidence before settling and returns the phase decided by Pi", async () => {
  const f = fixture();
  f.request.model = "provider/model";
  f.request.timeoutSeconds = 30;
  const result = await delegateKnowledge(f.request, f.dependencies);
  assert.deepEqual(f.calls, ["start", "execute", "save", "finish", "advance"]);
  assert.deepEqual(f.executions, [
    {
      task: f.request.task,
      cwd: "/workspace",
      role: "discovery.explorer",
      signal: f.controller.signal,
      timeoutMs: 30_000,
      model: "provider/model",
    },
  ]);
  assert.deepEqual(f.saved, [
    { cwd: "/workspace", attemptId: "attempt-1", brief: "# Discovery Brief\nEvidence" },
  ]);
  assert.deepEqual(f.completions, [
    {
      attemptId: "attempt-1",
      outcome: "succeeded",
      artifactPath: ".xper/artifacts/discovery-brief-attempt-1.md",
    },
  ]);
  assert.deepEqual(result, {
    attemptId: "attempt-1",
    outcome: "succeeded",
    phase: "define",
    gate: { advanced: true, phase: "define" },
    artifactId: "artifact-1",
    artifactPath: ".xper/artifacts/discovery-brief-attempt-1.md",
  });
  assert.deepEqual(f.observations, [
    { type: "attempt.correlated", attemptId: "attempt-1" },
    { type: "attempt.finished", attemptId: "attempt-1", outcome: "succeeded" },
  ]);
});

test("successful execution still respects a blocked Pi gate", async () => {
  const f = fixture();
  f.state.advance = { advanced: false, phase: "discovery", reason: "other assignments pending" };
  assert.equal((await delegateKnowledge(f.request, f.dependencies)).phase, "discovery");
  assert.equal(f.calls.filter((call) => call === "advance").length, 1);
});

for (const outcome of ["failed", "cancelled", "timed_out"] as const) {
  test(`delegation preserves ${outcome} without writing evidence or requesting advancement`, async () => {
    const f = fixture();
    f.state.execution = { outcome };
    const result = await delegateKnowledge(f.request, f.dependencies);
    assert.deepEqual(result, {
      attemptId: "attempt-1",
      outcome,
      phase: "discovery",
      artifactId: null,
    });
    assert.deepEqual(f.calls, ["start", "execute", "finish"]);
    assert.deepEqual(f.completions, [{ attemptId: "attempt-1", outcome }]);
    assert.equal(f.executions[0]?.timeoutMs, 120_000);
  });
}

test("retry passes the pending assignment identity through to Pi", async () => {
  const f = fixture();
  f.request.assignmentId = "interrupted-assignment";
  await delegateKnowledge(f.request, f.dependencies);
  assert.deepEqual(f.assignmentIds, ["interrupted-assignment"]);
});

test("invalid task or timeout is rejected before any effects", async () => {
  for (const override of [
    { task: "  " },
    ...[0, -1, 601, 1.5, Number.NaN].map((timeoutSeconds) => ({ timeoutSeconds })),
  ]) {
    const f = fixture();
    await assert.rejects(delegateKnowledge({ ...f.request, ...override }, f.dependencies));
    assert.deepEqual(f.calls, []);
  }
});

test("execution and artifact failures settle as failed without reporting a saved Brief", async () => {
  for (const failure of ["execute", "save"] as const) {
    const f = fixture();
    f.state.failure = failure;
    const result = await delegateKnowledge(f.request, f.dependencies);
    assert.equal(result.outcome, "failed");
    assert.equal(result.artifactPath, undefined);
    assert.deepEqual(f.completions, [{ attemptId: "attempt-1", outcome: "failed" }]);
    assert(!f.calls.includes("advance"));
  }
});

test("an execution exception after cancellation is settled as cancelled", async () => {
  const f = fixture();
  f.state.failure = "execute";
  f.controller.abort();
  assert.equal((await delegateKnowledge(f.request, f.dependencies)).outcome, "cancelled");
  assert.deepEqual(f.completions, [{ attemptId: "attempt-1", outcome: "cancelled" }]);
});

test("an empty successful response cannot produce a successful durable result", async () => {
  const f = fixture();
  f.state.execution = { outcome: "succeeded", brief: " \n" };
  assert.equal((await delegateKnowledge(f.request, f.dependencies)).outcome, "failed");
  assert.deepEqual(f.calls, ["start", "execute", "finish"]);
  assert.deepEqual(f.completions, [{ attemptId: "attempt-1", outcome: "failed" }]);
});

test("a rejected assignment does not start an agent or invent an attempt result", async () => {
  const f = fixture();
  f.state.failure = "start";
  await assert.rejects(
    delegateKnowledge(f.request, f.dependencies),
    (error) => error === f.failure,
  );
  assert.deepEqual(f.calls, ["start"]);
  assert.deepEqual(f.observations, []);
});

test("an uncertain local settlement failure propagates without resettling or advancing", async () => {
  const f = fixture();
  f.state.failure = "finish";
  await assert.rejects(
    delegateKnowledge(f.request, f.dependencies),
    (error) => error === f.failure,
  );
  assert.deepEqual(f.calls, ["start", "execute", "save", "finish"]);
  assert.equal(f.completions.length, 1);
  assert.deepEqual(f.observations, [{ type: "attempt.correlated", attemptId: "attempt-1" }]);
});

test("a failed advance never rewrites an already settled successful attempt", async () => {
  const f = fixture();
  f.state.failure = "advance";
  await assert.rejects(
    delegateKnowledge(f.request, f.dependencies),
    (error) => error === f.failure,
  );
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0]?.outcome, "succeeded");
  assert.equal(f.observations.length, 2);
});

test("a failed routed execution settles after one attempt", async () => {
  const f = fixture();
  const selected: ModelSelection = {
    context: "company",
    provider: "corp",
    model: "m1",
    thinking: "low",
  };
  f.dependencies.workflow.startAssignment = async (assignmentId) => {
    f.assignmentIds.push(assignmentId);
    return {
      runId: "run-1",
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      role: "discovery.explorer",
      selection: selected,
    };
  };
  f.state.execution = { outcome: "failed" };
  const result = await delegateKnowledge(f.request, f.dependencies);
  assert.deepEqual(f.assignmentIds, [undefined]);
  assert.deepEqual(
    f.executions.map((execution) => execution.selection),
    [selected],
  );
  assert.deepEqual(f.completions, [{ attemptId: "attempt-1", outcome: "failed" }]);
  assert.equal(result.outcome, "failed");
});

test("delegation obeys Pi artifact inputs and timeout and preserves a human gate", async () => {
  const f = fixture();
  f.dependencies.workflow.startAssignment = async () => ({
    runId: "r",
    assignmentId: "a",
    attemptId: "t",
    role: "define.product",
    selection: null,
    phase: "define",
    artifactKind: "definition_contract",
    artifactPath: ".xper/artifacts/definition-contract-t.json",
    inputArtifacts: [
      {
        artifact_id: "brief",
        kind: "discovery_brief",
        path: ".xper/artifacts/brief.md",
        version: 1,
      },
    ],
    timeoutMs: 1000,
  });
  f.state.advance = {
    advanced: false,
    phase: "define",
    reason: "human approval required",
    humanArtifactId: "definition",
  };
  f.dependencies.saveBrief = async (_cwd, _attempt, _content, path) => {
    assert(path);
    return path;
  };
  const result = await delegateKnowledge(f.request, f.dependencies);
  assert.equal(f.executions[0]?.timeoutMs, 1000);
  assert.equal(f.executions[0]?.inputArtifacts?.[0]?.artifact_id, "brief");
  assert.equal(result.gate?.humanArtifactId, "definition");
  assert.equal(result.artifactPath, ".xper/artifacts/definition-contract-t.json");
});

test("a Pi deadline normalizes late success to timeout without advancing", async () => {
  const f = fixture();
  f.dependencies.workflow.finishAttempt = async (request) => ({
    attemptId: request.attemptId,
    outcome: "timed_out",
    artifactId: null,
  });
  const result = await delegateKnowledge(f.request, f.dependencies);
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.artifactPath, undefined);
  assert(!f.calls.includes("advance"));
});

test("explicit artifact rejection settles malformed output as failed, while uncertain failures propagate", async () => {
  const f = fixture();
  f.dependencies.workflow.finishAttempt = async (request) => {
    f.completions.push(request);
    if (request.outcome === "succeeded")
      throw new WorkflowValidationError("artifact input references do not match");
    return { attemptId: request.attemptId, outcome: request.outcome, artifactId: null };
  };
  const result = await delegateKnowledge(f.request, f.dependencies);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /input references/);
  assert.equal(result.artifactPath, undefined);
  assert.equal(f.completions.length, 2);
  assert(!f.calls.includes("advance"));
});
