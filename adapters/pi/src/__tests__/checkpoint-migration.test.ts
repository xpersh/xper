import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import { transitionImplementation } from "../workflow/implementation/machine.js";
import { decodeCheckpoint } from "../workflow/knowledge/checkpoint.js";
import {
  type Artifact,
  type Assignment,
  type Attempt,
  toRunSummary,
} from "../workflow/knowledge/state.js";
import { type Phase, policyFrom } from "../workflow/policy.js";
import { WorkflowValidationError } from "../workflow/types.js";

// These historical labels intentionally do not derive from the new definition:
// a future graph edit must not silently redefine what a version 1 file meant.
const legacyPhases = [
  ["discovery", "discovery.explorer", "discovery_brief"],
  ["define", "define.product", "definition_contract"],
  ["design", "design.designer", "design_decisions"],
  ["breakdown", "breakdown.slicer", "story_map"],
  ["plan", "plan.planner", "execution_plan"],
] as const;

function legacyCheckpoint(lastPhase: "define" | "plan" = "define") {
  const selection = {
    context: "local",
    provider: "synthetic",
    model: "frozen-model",
    thinking: "medium",
  };
  const visits: Array<{ id: string; phase: Phase }> = [];
  const assignments: Record<string, Assignment> = {};
  const attempts: Record<string, Attempt> = {};
  const artifacts: Record<string, Artifact> = {};
  const accepted: Partial<Record<Phase, string>> = {};
  const inputs: string[] = [];
  for (const [phase, role, kind] of legacyPhases) {
    const visitId = `visit-${phase}`;
    const assignmentId = `assignment-${phase}`;
    const attemptId = `attempt-${phase}`;
    const artifactId = `artifact-${phase}`;
    const artifactPath = `.xper/artifacts/${phase}-${attemptId}.${phase === "discovery" ? "md" : "json"}`;
    visits.push({ id: visitId, phase });
    assignments[assignmentId] = {
      id: assignmentId,
      visitId,
      phase,
      role,
      inputs: [...inputs],
      selection: { ...selection },
      attemptIds: [attemptId],
    };
    attempts[attemptId] = {
      assignmentId,
      startedAt: 1_100 + visits.length,
      timeoutMs: 2_000,
      outcome: "succeeded",
      artifactId,
      artifactPath,
      selection: { ...selection },
    };
    artifacts[artifactId] = {
      artifact_id: artifactId,
      attemptId,
      kind,
      path: artifactPath,
      version: 1,
      digest: `sealed-${phase}`,
      inputs: [...inputs],
    };
    if (phase === lastPhase) break;
    accepted[phase] = artifactId;
    inputs.push(artifactId);
  }
  return {
    version: 1 as const,
    revision: 17,
    run_id: "legacy-run-identity",
    startedAt: 1_000,
    routing: {
      profile: "frozen-profile",
      context: "local",
      routes: Object.fromEntries(legacyPhases.map(([, role]) => [role, [{ ...selection }]])),
    },
    policy: policyFrom({
      maxAttempts: 40,
      maxTimeMs: 100_000,
      attemptTimeMs: 2_000,
      maxConcurrency: 3,
      maxCostMicros: 1_000,
      attemptCostMicros: 10,
      humanGates: ["define"],
    }),
    visits,
    assignments,
    attempts,
    artifacts,
    accepted,
    feedback: null as string | null,
    human_input: null as [string, string] | null,
    ready: false,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

test("version 1 migration preserves identities, sealed evidence, frozen routing and consumed attempt history", () => {
  const legacy = deepFreeze(legacyCheckpoint());
  const original = JSON.stringify(legacy);
  const state = decodeCheckpoint(legacy);
  assert(state);
  assert.equal(state.version, 3);
  assert.deepEqual(state.definition, { id: "pi.knowledge", version: 2 });
  assert.equal(state.instanceId, legacy.run_id);
  assert.deepEqual(state.lifecycle, { status: "active" });
  const { version: _version, ready: _ready, human_input: _humanInput, ...historical } = legacy;
  const {
    version: _nextVersion,
    definition: _definition,
    instanceId: _instance,
    imports: _imports,
    lifecycle: _lifecycle,
    ...preserved
  } = state;
  assert.deepEqual(preserved, historical);
  assert.equal(JSON.stringify(legacy), original);
  assert(!Object.hasOwn(state, "ready"));
  assert(!Object.hasOwn(state, "human_input"));
  assert.notEqual(state.attempts, legacy.attempts);
});

test("version 1 and 2 knowledge checkpoints migrate into an empty version 9 envelope", () => {
  const legacy = deepFreeze(legacyCheckpoint());
  const fromOne = decodeAdapterCheckpoint(legacy);
  assert(fromOne);
  assert.equal(fromOne.version, 9);
  assert.equal(fromOne.knowledge.run_id, legacy.run_id);
  assert.deepEqual(fromOne.implementations, {});
  assert.deepEqual(fromOne.verifications, {});
  assert.equal(fromOne.authorizedPlan, null);
  assert.deepEqual(fromOne.reconciliations, []);

  const versionTwo = decodeCheckpoint(legacy);
  assert(versionTwo);
  const fromTwo = decodeAdapterCheckpoint(deepFreeze(versionTwo));
  assert(fromTwo);
  assert.deepEqual(fromTwo.knowledge, versionTwo);
  assert.deepEqual(fromTwo.implementations, {});
  assert.deepEqual(fromTwo.verifications, {});
});

test("version 3 wraps its existing implementation as the first immutable history entry", () => {
  const legacy = legacyCheckpoint("plan");
  legacy.accepted.plan = "artifact-plan";
  legacy.ready = true;
  const knowledge = decodeCheckpoint(legacy);
  assert(knowledge);
  const inputs = Object.values(knowledge.accepted);
  const started = transitionImplementation(
    null,
    {
      type: "assignment.start",
      runId: knowledge.run_id,
      instanceId: "implementation-s1-1",
      attemptId: "implementation-attempt-1",
      planArtifactId: "artifact-plan",
      planDigest: "sealed-plan",
      assignment: {
        id: "driver",
        incrementId: "s1",
        role: "implementation.driver",
        dependencies: [],
        workspace: "s1",
        resources: [],
        maxAttempts: 2,
        maxTimeMs: 1_000,
        maxCostMicros: 0,
      },
      inputs,
      inputArtifacts: inputs.map((id) => ({
        artifact_id: id,
        kind: knowledge.artifacts[id]?.kind ?? "unknown",
        path: knowledge.artifacts[id]?.path ?? "unknown",
        version: 1,
      })),
      criteria: [{ id: "c1", behavior: "Works", example: "Observed" }],
      verification: ["run focused test"],
      selection: null,
      model: "synthetic/model",
      baseCommit: "1111111111111111111111111111111111111111",
      attemptTimeMs: 500,
      attemptCostMicros: 0,
      globalBudget: { attempts: 10, timeMs: 10_000, costMicros: null, concurrency: 1 },
    },
    2_000,
  );
  const versionThree = deepFreeze({
    version: 3,
    knowledge,
    implementations: { s1: started.state },
  });
  const migrated = decodeAdapterCheckpoint(versionThree);
  assert(migrated);
  assert.equal(migrated.version, 9);
  assert.deepEqual(migrated.implementations.s1, [started.state]);
  assert.deepEqual(migrated.verifications, {});
  assert.equal(JSON.stringify(versionThree).includes('"version":4'), false);

  const second = structuredClone(started.state);
  second.instanceId = "implementation-s2-1";
  second.incrementId = "s2";
  second.assignment = {
    ...second.assignment,
    id: "driver-2",
    incrementId: "s2",
    workspace: "s2",
    attemptIds: ["implementation-attempt-2"],
  };
  const firstAttempt = second.attempts["implementation-attempt-1"];
  assert(firstAttempt);
  second.attempts = {
    "implementation-attempt-2": {
      ...firstAttempt,
      artifactPath: ".xper/artifacts/implementation-attempt-2.json",
    },
  };
  assert.throws(
    () =>
      decodeAdapterCheckpoint({
        version: 4,
        knowledge,
        implementations: { s1: [started.state], s2: [second] },
        verifications: {},
      }),
    /invalid overlapping delivery checkpoint/,
  );

  assert.throws(
    () =>
      decodeAdapterCheckpoint({
        ...versionThree,
        implementations: {
          s1: { ...started.state, planDigest: "wrong-plan-digest" },
        },
      }),
    /invalid implementation checkpoint identity/,
  );
  assert.throws(
    () =>
      decodeAdapterCheckpoint({
        ...versionThree,
        implementations: {
          s1: { ...started.state, instanceId: knowledge.instanceId },
        },
      }),
    /invalid implementation checkpoint identity/,
  );
});

test("migration keeps unfinished attempts unfinished and decoding twice is idempotent", () => {
  const legacy = legacyCheckpoint();
  const running = legacy.attempts["attempt-define"];
  assert(running);
  running.outcome = null;
  running.artifactId = null;
  delete legacy.artifacts["artifact-define"];
  const state = decodeCheckpoint(deepFreeze(legacy));
  assert(state);
  assert.equal(state.attempts["attempt-define"]?.outcome, null);
  assert.equal(state.attempts["attempt-define"]?.startedAt, running.startedAt);
  assert.deepEqual(decodeCheckpoint(deepFreeze(state)), state);
});

test("pending approval migrates its exact visit and artifact and remains a derived compatibility view", () => {
  const legacy = legacyCheckpoint();
  legacy.human_input = ["visit-define", "artifact-define"];
  const state = decodeCheckpoint(deepFreeze(legacy));
  assert(state);
  assert.deepEqual(state.lifecycle, {
    status: "awaiting_approval",
    visitId: "visit-define",
    artifactId: "artifact-define",
  });
  const summary = toRunSummary(state);
  assert.deepEqual(summary.human_input, legacy.human_input);
  assert.equal(summary.ready, false);
  assert(summary.human_input);
  summary.human_input[1] = "changed-presentation-only";
  assert.deepEqual(state.lifecycle, {
    status: "awaiting_approval",
    visitId: "visit-define",
    artifactId: "artifact-define",
  });
});

test("a completed legacy Plan migrates its accepted artifact without entering a future workflow", () => {
  const legacy = legacyCheckpoint("plan");
  legacy.accepted.plan = "artifact-plan";
  legacy.ready = true;
  const state = decodeCheckpoint(deepFreeze(legacy));
  assert(state);
  assert.deepEqual(state.lifecycle, { status: "completed", artifactId: "artifact-plan" });
  assert.equal(state.visits.at(-1)?.phase, "plan");
  assert.equal(Object.keys(state.attempts).length, 5);
  assert.equal(toRunSummary(state).ready, true);
  assert.equal(toRunSummary(state).human_input, null);
});

test("conflicting or detached historical lifecycle data is rejected without resetting it", () => {
  const conflicting = legacyCheckpoint("plan");
  conflicting.ready = true;
  conflicting.accepted.plan = "artifact-plan";
  conflicting.human_input = ["visit-plan", "artifact-plan"];
  const original = JSON.stringify(conflicting);
  assert.throws(() => decodeCheckpoint(deepFreeze(conflicting)), WorkflowValidationError);
  assert.equal(JSON.stringify(conflicting), original);

  const wrongVisit = legacyCheckpoint();
  wrongVisit.human_input = ["visit-discovery", "artifact-define"];
  assert.throws(() => decodeCheckpoint(wrongVisit), WorkflowValidationError);

  const missingEvidence = legacyCheckpoint();
  const assignment = missingEvidence.assignments["assignment-define"];
  assert(assignment);
  assignment.inputs = ["missing-evidence"];
  assert.throws(() => decodeCheckpoint(missingEvidence), WorkflowValidationError);
});

test("unknown checkpoint or definition versions are rejected and existing instance identity survives reload", () => {
  assert.equal(decodeCheckpoint(null), null);
  const state = decodeCheckpoint(legacyCheckpoint());
  assert(state);
  const secondInstance = { ...state, instanceId: "another-knowledge-instance" };
  assert.equal(decodeCheckpoint(secondInstance)?.instanceId, "another-knowledge-instance");
  assert.equal(state.instanceId, "legacy-run-identity");
  for (const incompatible of [
    { ...state, version: 99 },
    { ...state, definition: { id: "pi.knowledge", version: 99 } },
    { ...state, definition: { id: "future.increment", version: 1 } },
    { ...state, lifecycle: { status: "unrecognized" } },
    undefined,
  ]) {
    assert.throws(() => decodeCheckpoint(incompatible), WorkflowValidationError);
  }
});
