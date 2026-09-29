import assert from "node:assert/strict";
import test from "node:test";
import { type Phase, policyFrom } from "../workflow/policy.js";
import {
  type Artifact,
  type Assignment,
  type Attempt,
  decodeAdapterCheckpoint,
  decodeCheckpoint,
  toRunSummary,
} from "../workflow/state.js";
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
  assert.equal(state.version, 2);
  assert.deepEqual(state.definition, { id: "pi.knowledge", version: 1 });
  assert.equal(state.instanceId, legacy.run_id);
  assert.deepEqual(state.lifecycle, { status: "active" });
  const { version: _version, ready: _ready, human_input: _humanInput, ...historical } = legacy;
  const {
    version: _nextVersion,
    definition: _definition,
    instanceId: _instance,
    lifecycle: _lifecycle,
    ...preserved
  } = state;
  assert.deepEqual(preserved, historical);
  assert.equal(JSON.stringify(legacy), original);
  assert(!Object.hasOwn(state, "ready"));
  assert(!Object.hasOwn(state, "human_input"));
  assert.notEqual(state.attempts, legacy.attempts);
});

test("version 1 and 2 knowledge checkpoints migrate into an empty version 3 envelope", () => {
  const legacy = deepFreeze(legacyCheckpoint());
  const fromOne = decodeAdapterCheckpoint(legacy);
  assert(fromOne);
  assert.equal(fromOne.version, 3);
  assert.equal(fromOne.knowledge.run_id, legacy.run_id);
  assert.deepEqual(fromOne.implementations, {});

  const versionTwo = decodeCheckpoint(legacy);
  assert(versionTwo);
  const fromTwo = decodeAdapterCheckpoint(deepFreeze(versionTwo));
  assert(fromTwo);
  assert.deepEqual(fromTwo.knowledge, versionTwo);
  assert.deepEqual(fromTwo.implementations, {});
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
