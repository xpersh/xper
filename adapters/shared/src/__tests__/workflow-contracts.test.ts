import assert from "node:assert/strict";
import test from "node:test";
import {
  selectImplementationHandoff,
  selectNextImplementationHandoff,
  validateDag,
  validateLinks,
} from "../workflow/delivery/plan.js";
import type { PlannedAssignment } from "../workflow/knowledge/contract.js";
import { parseDocument } from "../workflow/knowledge/contracts.js";
import { fixtures, twoIncrementOutputs } from "./workflow-harness.js";

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

test("next implementation selection uses verified dependency evidence and pending budgets", () => {
  const dependent = twoIncrementOutputs(true);
  const definitionFixture = fixtures.find((fixture) => fixture.phase === "define")?.artifact;
  const breakdownFixture = fixtures.find((fixture) => fixture.phase === "breakdown")?.artifact;
  assert(definitionFixture && breakdownFixture);
  const upstream = {
    define: { ...structuredClone(definitionFixture), output: dependent.definition },
    breakdown: { ...structuredClone(breakdownFixture), output: dependent.breakdown },
  };
  const [driver, verifier] = dependent.plan.assignments;
  assert(driver && verifier);
  const implementationOnly = new Map([[driver.id, "implementation-1"]]);
  const blocked = selectNextImplementationHandoff(
    dependent.plan,
    upstream,
    null,
    implementationOnly,
  );
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked")
    assert.deepEqual(blocked.unsatisfiedDependencyIds, [verifier.id]);

  const verified = new Map([
    [driver.id, "implementation-1"],
    [verifier.id, "verification-1"],
  ]);
  const next = selectNextImplementationHandoff(dependent.plan, upstream, null, verified);
  assert.equal(next.status, "ready");
  if (next.status === "ready") {
    assert.equal(next.handoff.incrementId, "s2");
    assert.deepEqual(next.dependencyArtifactIds, ["verification-1"]);
  }
  assert.throws(
    () =>
      validateLinks(dependent.plan, upstream, {
        attempts: 2,
        timeMs: 2_000,
        costMicros: 0,
        concurrency: 1,
      }),
    /exceeds remaining run budgets/,
  );
  validateLinks(
    dependent.plan,
    upstream,
    { attempts: 2, timeMs: 2_000, costMicros: 0, concurrency: 1 },
    new Set(verified.keys()),
  );

  const independent = twoIncrementOutputs(false);
  const independentUpstream = {
    define: { ...structuredClone(definitionFixture), output: independent.definition },
    breakdown: { ...structuredClone(breakdownFixture), output: independent.breakdown },
  };
  const independentNext = selectNextImplementationHandoff(
    independent.plan,
    independentUpstream,
    null,
    verified,
  );
  assert.equal(independentNext.status, "ready");
  if (independentNext.status === "ready") {
    assert.equal(independentNext.handoff.incrementId, "s2");
    assert.deepEqual(independentNext.dependencyArtifactIds, []);
  }
});
