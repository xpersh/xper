import assert from "node:assert/strict";
import test from "node:test";
import { findTransition, knowledgeDefinition } from "../workflow/definition.js";
import {
  transitionKnowledge,
  workflowPosition,
  type Evidence,
  type KnowledgeEvent,
  type WorkflowFact,
} from "../workflow/knowledge-machine.js";
import type { WorkflowState } from "../workflow/state.js";
import type { WorkflowPolicy } from "../workflow/types.js";
import type { Output } from "../workflow/contracts.js";

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function startEvent(
  runId = "run-a",
  policy?: WorkflowPolicy,
  instanceId = `${runId}-knowledge`,
): Extract<KnowledgeEvent, { type: "run.start" }> {
  return {
    type: "run.start",
    runId,
    instanceId,
    visitId: `${runId}-discovery`,
    objectiveHash: "synthetic-objective-hash",
    configuration: { routing: null, adapterConfig: {} },
    ...(policy ? { policy } : {}),
  };
}
function start(
  runId = "run-a",
  policy?: WorkflowPolicy,
  instanceId = `${runId}-knowledge`,
): WorkflowState {
  return transitionKnowledge(null, startEvent(runId, policy, instanceId), 100).state;
}
function produce(previous: WorkflowState, id: string, output?: Output, now = 200) {
  const assigned = transitionKnowledge(
    previous,
    { type: "assignment.start", newAssignmentId: `${id}-assignment`, attemptId: `${id}-attempt` },
    now,
  );
  assert(assigned.result.artifactPath);
  const evidence: Evidence = {
    content: output
      ? JSON.stringify({
          schemaVersion: 1,
          inputs: assigned.result.inputArtifacts?.map((a) => a.artifact_id),
          output,
        })
      : "# Brief\nSynthetic evidence",
    digest: `synthetic-digest-${id}`,
  };
  const completion: Extract<KnowledgeEvent, { type: "attempt.finish" }> = {
    type: "attempt.finish",
    result: {
      attemptId: assigned.result.attemptId,
      outcome: "succeeded",
      artifactPath: assigned.result.artifactPath,
    },
    artifactId: `${id}-artifact`,
    evidence,
  };
  const finished = transitionKnowledge(assigned.state, completion, now + 10);
  return {
    state: finished.state,
    artifactId: completion.artifactId,
    evidence,
    assigned,
    completion,
  };
}
function assertEdge(facts: WorkflowFact[], from: Parameters<typeof findTransition>[1], to: string) {
  const fact = facts.find((item) => item.type === "workflow.transition");
  assert(fact);
  assert.equal(typeof fact.data.transitionId, "string");
  const edge = findTransition(knowledgeDefinition, from, String(fact.data.transitionId));
  assert(edge);
  assert.equal(fact.data.from, edge.from);
  assert.equal(fact.data.to, edge.to);
  assert.equal(edge.to, to);
}

test("knowledge transitions are deterministic with deeply frozen state and event inputs", () => {
  const initial = freeze(startEvent("immutable", { humanGates: ["define"] }));
  const initialBefore = structuredClone(initial);
  const one = transitionKnowledge(null, initial, 100),
    two = transitionKnowledge(null, initial, 100);
  assert.deepEqual(one, two);
  assert.deepEqual(initial, initialBefore);
  const previous = freeze(one.state);
  const event = freeze({
    type: "assignment.start",
    newAssignmentId: "a1",
    attemptId: "t1",
  } satisfies KnowledgeEvent);
  const previousBefore = structuredClone(previous),
    eventBefore = structuredClone(event);
  const first = transitionKnowledge(previous, event, 110),
    second = transitionKnowledge(previous, event, 110);
  assert.deepEqual(first, second);
  assert.deepEqual(previous, previousBefore);
  assert.deepEqual(event, eventBefore);
  assert.notEqual(first.state, previous);
  assert.equal(previous.attempts.t1, undefined);
  const finish = freeze({
    type: "attempt.finish",
    artifactId: "artifact",
    result: {
      attemptId: "t1",
      outcome: "succeeded",
      artifactPath: first.result.artifactPath ?? "",
    },
    evidence: { content: "# Brief\nEvidence", digest: "synthetic-digest" },
  } satisfies KnowledgeEvent);
  freeze(first.state);
  assert.deepEqual(
    transitionKnowledge(first.state, finish, 120),
    transitionKnowledge(first.state, finish, 120),
  );
  assert.equal(first.state.attempts.t1?.outcome, null);
});

test("a started instance owns its policy snapshot and rejects incompatible definitions on resume", () => {
  const policy: WorkflowPolicy = { humanGates: ["define"] };
  const event = startEvent("snapshot", policy);
  const started = transitionKnowledge(null, event, 100);
  policy.humanGates?.push("design");
  assert.deepEqual(started.state.policy.humanGates, ["define"]);
  started.state.policy.humanGates.push("breakdown");
  assert.deepEqual(event.policy?.humanGates, ["define", "design"]);
  const incompatible = freeze({
    ...started.state,
    definition: { ...started.state.definition, version: knowledgeDefinition.version + 1 },
  });
  const before = structuredClone(incompatible);
  assert.throws(
    () => transitionKnowledge(incompatible, startEvent("resume"), 110),
    /unsupported workflow definition/,
  );
  assert.deepEqual(incompatible, before);
});

test("interleaved instances and parallel attempts retain separate execution state", () => {
  const initialA = freeze(start("shared-run", undefined, "instance-a")),
    initialB = freeze(start("shared-run", undefined, "instance-b"));
  const a1 = transitionKnowledge(
    initialA,
    { type: "assignment.start", newAssignmentId: "assignment-1", attemptId: "attempt-1" },
    110,
  );
  const b1 = transitionKnowledge(
    initialB,
    { type: "assignment.start", newAssignmentId: "assignment-1", attemptId: "attempt-1" },
    111,
  );
  const a2 = transitionKnowledge(
    a1.state,
    { type: "assignment.start", newAssignmentId: "assignment-2", attemptId: "attempt-2" },
    112,
  );
  const settledB = transitionKnowledge(
    b1.state,
    {
      type: "attempt.finish",
      artifactId: "unused-b",
      result: { attemptId: "attempt-1", outcome: "cancelled" },
    },
    120,
  );
  const settledA = transitionKnowledge(
    a2.state,
    {
      type: "attempt.finish",
      artifactId: "unused-a",
      result: { attemptId: "attempt-1", outcome: "failed" },
    },
    121,
  );
  assert.equal(settledA.state.run_id, settledB.state.run_id);
  assert.notEqual(settledA.state.run_id, settledA.state.instanceId);
  assert.equal(settledA.state.instanceId, "instance-a");
  assert.equal(settledB.state.instanceId, "instance-b");
  assert.equal(settledA.state.attempts["attempt-1"]?.outcome, "failed");
  assert.equal(settledB.state.attempts["attempt-1"]?.outcome, "cancelled");
  assert.equal(settledA.state.attempts["attempt-2"]?.outcome, null);
  assert.equal(settledB.state.attempts["attempt-2"], undefined);
  assert.deepEqual(workflowPosition(settledA.state).activeAttemptIds, ["attempt-2"]);
  assert.deepEqual(workflowPosition(settledB.state).activeAttemptIds, []);
  assert.deepEqual(initialA.attempts, {});
  assert.deepEqual(initialB.attempts, {});
  const blocked = transitionKnowledge(
    settledA.state,
    { type: "gate.evaluate", nextVisitId: "unused", evidence: { artifacts: {} } },
    122,
  );
  assert.equal(blocked.result.advanced, false);
  assert(!blocked.facts.some((fact) => fact.type === "workflow.transition"));
});

test("rejected transitions leave their inputs intact, including tentative assignments", () => {
  const assigned = transitionKnowledge(
    start(),
    { type: "assignment.start", newAssignmentId: "a1", attemptId: "t1" },
    110,
  );
  const previous = freeze(assigned.state),
    before = structuredClone(previous);
  const invalidEvents: KnowledgeEvent[] = [
    { type: "assignment.start", newAssignmentId: "tentative", attemptId: "t1" },
    {
      type: "attempt.finish",
      artifactId: "a",
      result: { attemptId: "unknown", outcome: "failed" },
    },
    {
      type: "attempt.finish",
      artifactId: "a",
      result: { attemptId: "t1", outcome: "succeeded", artifactPath: "unexpected.md" },
      evidence: { content: "evidence", digest: "digest" },
    },
    ...[
      { content: " \n", digest: "digest" },
      { content: "# Brief", digest: " " },
    ].map(
      (evidence): KnowledgeEvent => ({
        type: "attempt.finish",
        artifactId: "a",
        result: {
          attemptId: "t1",
          outcome: "succeeded",
          artifactPath: assigned.result.artifactPath ?? "",
        },
        evidence,
      }),
    ),
    { type: "assignment.start", assignmentId: "a1", newAssignmentId: "unused", attemptId: "t2" },
  ];
  for (const event of invalidEvents) {
    freeze(event);
    const eventBefore = structuredClone(event);
    assert.throws(() => transitionKnowledge(previous, event, 120));
    assert.deepEqual(previous, before);
    assert.deepEqual(event, eventBefore);
  }
  assert.equal(previous.assignments.tentative, undefined);
});

test("recovery interrupts only unfinished attempts and never requests another execution", () => {
  let state = start("recover");
  for (const outcome of ["failed", "cancelled", "timed_out"] as const) {
    state = transitionKnowledge(
      state,
      { type: "assignment.start", newAssignmentId: `a-${outcome}`, attemptId: `t-${outcome}` },
      110,
    ).state;
    state = transitionKnowledge(
      state,
      {
        type: "attempt.finish",
        artifactId: "unused",
        result: { attemptId: `t-${outcome}`, outcome },
      },
      120,
    ).state;
  }
  state = produce(state, "successful").state;
  state = transitionKnowledge(
    state,
    { type: "assignment.start", newAssignmentId: "a-running", attemptId: "t-running" },
    220,
  ).state;
  const previous = freeze(state),
    before = structuredClone(previous);
  const recovered = transitionKnowledge(
    previous,
    freeze({ type: "session.recover" } as const),
    230,
  );
  assert.equal(recovered.result, undefined);
  assert.equal(recovered.state.attempts["t-running"]?.outcome, "interrupted");
  for (const outcome of ["failed", "cancelled", "timed_out"] as const)
    assert.equal(recovered.state.attempts[`t-${outcome}`]?.outcome, outcome);
  assert.equal(recovered.state.attempts["successful-attempt"]?.outcome, "succeeded");
  assert.deepEqual(
    recovered.facts
      .filter((fact) => fact.type === "attempt.finished")
      .map((fact) => fact.data.attemptId),
    ["t-running"],
  );
  assert(
    recovered.facts.every((fact) => ["attempt.finished", "workflow.position"].includes(fact.type)),
  );
  assert.deepEqual(previous, before);
  const repeated = transitionKnowledge(freeze(recovered.state), { type: "session.recover" }, 240);
  assert.deepEqual(repeated.state, recovered.state);
  assert.deepEqual(repeated.facts, []);
  assert.equal(repeated.result, undefined);
});

test("approval and feedback transitions follow the published graph and preserve visit identity", () => {
  const discovery = produce(start("gates", { humanGates: ["define"] }), "discovery");
  const evidence: Record<string, Evidence> = { [discovery.artifactId]: discovery.evidence };
  const defined = transitionKnowledge(
    freeze(discovery.state),
    freeze({
      type: "gate.evaluate",
      nextVisitId: "define-visit",
      evidence: { artifacts: evidence },
    } as const),
    220,
  );
  assertEdge(defined.facts, "discovery", "define");
  assert.equal(defined.state.visits.at(-1)?.id, "define-visit");
  const definition = produce(
    defined.state,
    "definition",
    {
      kind: "definition_contract",
      goal: "Return a greeting",
      scope: ["A greeting"],
      exclusions: [],
      criteria: [
        {
          id: "greeting",
          behavior: "Display a greeting",
          example: "Given a name, include it in the greeting",
        },
      ],
    },
    230,
  );
  const allEvidence = { ...evidence, [definition.artifactId]: definition.evidence };
  const waiting = transitionKnowledge(
    definition.state,
    { type: "gate.evaluate", nextVisitId: "unused", evidence: { artifacts: allEvidence } },
    250,
  );
  assert.deepEqual(waiting.state.lifecycle, {
    status: "awaiting_approval",
    visitId: "define-visit",
    artifactId: definition.artifactId,
  });
  assert.equal(waiting.result.advanced, false);
  assert(!waiting.facts.some((fact) => fact.type === "workflow.transition"));
  const previous = freeze(waiting.state),
    before = structuredClone(previous);
  assert.throws(
    () =>
      transitionKnowledge(
        previous,
        {
          type: "gate.evaluate",
          nextVisitId: "wrong",
          approvedArtifactId: "unrelated",
          evidence: { artifacts: allEvidence },
        },
        260,
      ),
    /approval does not match/,
  );
  assert.deepEqual(previous, before);
  const approved = transitionKnowledge(
    previous,
    {
      type: "gate.evaluate",
      nextVisitId: "design-visit",
      approvedArtifactId: definition.artifactId,
      evidence: { artifacts: allEvidence },
    },
    260,
  );
  assertEdge(approved.facts, "define", "design");
  assert.equal(approved.state.lifecycle.status, "active");
  const feedback = produce(
    approved.state,
    "feedback",
    {
      kind: "feedback",
      reason: "missing_context",
      evidence: "The external interface is undocumented",
    },
    270,
  );
  const feedbackBefore = structuredClone(feedback.state);
  assert.throws(
    () =>
      transitionKnowledge(
        freeze(feedback.state),
        {
          type: "gate.evaluate",
          nextVisitId: "gates-discovery",
          evidence: { artifacts: { ...allEvidence, [feedback.artifactId]: feedback.evidence } },
        },
        290,
      ),
    /visit ID already exists/,
  );
  assert.deepEqual(feedback.state, feedbackBefore);
  const revisited = transitionKnowledge(
    feedback.state,
    {
      type: "gate.evaluate",
      nextVisitId: "discovery-revisit",
      evidence: { artifacts: { ...allEvidence, [feedback.artifactId]: feedback.evidence } },
    },
    290,
  );
  assertEdge(revisited.facts, "design", "discovery");
  assert.equal(revisited.state.feedback, feedback.artifactId);
  assert.deepEqual(revisited.state.accepted, {});
  assert.equal(revisited.state.visits.at(-1)?.id, "discovery-revisit");
  assert.notEqual(revisited.state.visits.at(-1)?.id, discovery.state.visits[0]?.id);
  const position = revisited.facts.find((fact) => fact.type === "workflow.position");
  assert(position);
  assert.equal(position.data.definitionId, knowledgeDefinition.id);
  assert.equal(position.data.definitionVersion, knowledgeDefinition.version);
  assert.equal(position.data.instanceId, "gates-knowledge");
  assert.equal(position.data.nodeId, "discovery");
});

test("delivery feedback reopens ready Knowledge exactly once and invalidates downstream acceptance", async (t) => {
  for (const [reason, target, retained] of [
    ["ambiguous_criteria", "define", ["discovery"]],
    ["infeasible_design", "design", ["discovery", "define"]],
  ] as const) {
    await t.test(`${reason} reopens ${target}`, () => {
      const ready = start(`delivery-${target}`);
      ready.visits.push({ id: `${target}-plan`, phase: "plan" });
      for (const phase of ["discovery", "define", "design", "breakdown", "plan"] as const) {
        const artifactId = `${target}-${phase}-artifact`;
        ready.artifacts[artifactId] = {
          artifact_id: artifactId,
          attemptId: `${target}-${phase}-attempt`,
          kind: phase === "plan" ? "execution_plan" : `${phase}_artifact`,
          path: `.xper/artifacts/${phase}-${target}.json`,
          version: 1,
          digest: `${phase}-${target}-digest`,
          inputs: [],
        };
        ready.accepted[phase] = artifactId;
      }
      const planId = ready.accepted.plan;
      assert(planId);
      ready.lifecycle = { status: "completed", artifactId: planId };
      const event = {
        type: "delivery.feedback" as const,
        nextVisitId: `${target}-revisit`,
        sourceAttemptId: `${target}-verification-attempt`,
        incrementId: "s1",
        planArtifactId: planId,
        planDigest: ready.artifacts[planId]?.digest ?? "",
        reason,
        evidence: "The sealed contract cannot be verified as written",
        paths: ["src/change.ts"],
        artifact: {
          artifact_id: `${target}-verification-artifact`,
          kind: "verification_result",
          path: `.xper/artifacts/verification-result-${target}.json`,
          version: 1,
          digest: `${target}-verification-digest`,
        },
      };
      const revisited = transitionKnowledge(ready, event, 500);
      assertEdge(revisited.facts, "ready", target);
      assert.equal(revisited.state.feedback, event.artifact.artifact_id);
      assert.equal(revisited.state.visits.at(-1)?.phase, target);
      assert.deepEqual(Object.keys(revisited.state.accepted), retained);
      assert.equal(
        revisited.facts.filter((fact) => fact.type === "artifact.invalidated").length,
        target === "define" ? 4 : 3,
      );
      const replay = transitionKnowledge(revisited.state, event, 510);
      assert.equal(replay.facts.length, 0);
      assert.throws(
        () =>
          transitionKnowledge(
            revisited.state,
            {
              ...event,
              nextVisitId: `${target}-other-revisit`,
              artifact: { ...event.artifact, artifact_id: `${target}-other-feedback` },
            },
            520,
          ),
        /finish the current Knowledge revisit/,
      );
    });
  }
});
