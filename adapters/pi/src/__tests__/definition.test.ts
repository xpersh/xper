import assert from "node:assert/strict";
import test from "node:test";
import {
  defineWorkflow,
  feedbackTransition,
  findTransition,
  forwardTransition,
  isKnowledgePhase,
  knowledgeDefinition,
  nextPhase,
  outgoingTransitions,
  phasesInvalidatedBy,
  reachableStates,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type KnowledgeNodeId,
} from "../workflow/definition.js";
import { contracts, feedbackTargets, phases } from "../workflow/policy.js";

type ReviewState = "queue" | "automatic" | "manual" | "done";
const reviewDefinition: WorkflowDefinition<ReviewState> = {
  schemaVersion: 1,
  id: "synthetic.review",
  version: 3,
  initial: "queue",
  nodes: [
    { id: "queue", label: "Queue", kind: "activity" },
    {
      id: "automatic",
      label: "Automatic review",
      kind: "activity",
      role: "review.robot",
      artifactKind: "review_report",
    },
    { id: "manual", label: "Human review", kind: "activity" },
    { id: "done", label: "Closed", kind: "terminal" },
  ],
  edges: [
    {
      id: "route.automatic",
      from: "queue",
      to: "automatic",
      event: "route",
      kind: "forward",
      guards: ["The item meets automatic review criteria"],
    },
    {
      id: "route.manual",
      from: "queue",
      to: "manual",
      event: "route",
      kind: "forward",
      guards: ["A human review is required"],
    },
    {
      id: "automatic.done",
      from: "automatic",
      to: "done",
      event: "review.accepted",
      kind: "completion",
      guards: ["The automated report is accepted"],
    },
    {
      id: "manual.done",
      from: "manual",
      to: "done",
      event: "review.accepted",
      kind: "completion",
      guards: ["The reviewer approved the item"],
    },
    {
      id: "manual.queue",
      from: "manual",
      to: "queue",
      event: "review.returned",
      kind: "feedback",
      guards: ["The reviewer requested another pass"],
    },
  ],
};

test("generic workflow definitions support unrelated state names, branching and feedback cycles", () => {
  const definition = defineWorkflow(reviewDefinition);
  assert.deepEqual(
    outgoingTransitions(definition, "queue", "route").map((edge) => edge.id),
    ["route.automatic", "route.manual"],
  );
  assert.equal(findTransition(definition, "queue", "route.manual")?.to, "manual");
  assert.equal(findTransition(definition, "automatic", "route.manual"), undefined);
  assert.equal(findTransition(definition, "manual", "manual.queue")?.to, "queue");
  assert.deepEqual(outgoingTransitions(definition, "done"), []);
  assert.deepEqual(
    new Set(reachableStates(definition, "queue", ["forward", "completion"])),
    new Set(["queue", "automatic", "manual", "done"]),
  );
  assert.deepEqual(
    new Set(reachableStates(definition, "manual", ["forward", "completion", "feedback"])),
    new Set(["queue", "automatic", "manual", "done"]),
  );
});

test("definitions round-trip as data and are frozen independently of caller-owned input", () => {
  const original = structuredClone(reviewDefinition);
  const definition = defineWorkflow(original);
  const parsed: WorkflowDefinition<ReviewState> = JSON.parse(JSON.stringify(definition));
  validateWorkflowDefinition(parsed);
  assert.deepEqual(parsed, original);
  assert(Object.isFrozen(definition));
  assert(Object.isFrozen(definition.nodes));
  assert(Object.isFrozen(definition.edges));
  assert(Object.isFrozen(definition.edges[0]?.guards));
  assert(Object.isFrozen(definition.nodes[0]));
  const originalFirst = original.nodes[0];
  assert(originalFirst);
  Object.assign(originalFirst, { label: "Changed by caller" });
  assert.equal(definition.nodes[0]?.label, "Queue");
  assert.throws(
    () => Object.assign(definition.nodes[0] ?? {}, { label: "Cannot change" }),
    TypeError,
  );
  assert.doesNotMatch(JSON.stringify(definition), /=>|function\s*\(/);
});

test("topology validation rejects ambiguous identities, dangling references and unreachable stubs", () => {
  const invalid: WorkflowDefinition<string>[] = [
    { ...reviewDefinition, id: "" },
    { ...reviewDefinition, version: 0 },
    { ...reviewDefinition, version: 1.5 },
    { ...reviewDefinition, initial: "undeclared" },
    { ...reviewDefinition, nodes: [] },
    {
      ...reviewDefinition,
      nodes: [...reviewDefinition.nodes, ...reviewDefinition.nodes.slice(0, 1)],
    },
    {
      ...reviewDefinition,
      edges: [...reviewDefinition.edges, ...reviewDefinition.edges.slice(0, 1)],
    },
    {
      ...reviewDefinition,
      edges: [
        ...reviewDefinition.edges,
        {
          id: "bad.reference",
          from: "manual",
          to: "undeclared",
          event: "go",
          kind: "forward",
          guards: [],
        },
      ],
    },
    {
      ...reviewDefinition,
      edges: [
        ...reviewDefinition.edges,
        { id: "bad.terminal", from: "done", to: "queue", event: "go", kind: "forward", guards: [] },
      ],
    },
    {
      ...reviewDefinition,
      edges: [
        ...reviewDefinition.edges,
        {
          id: "bad.completion",
          from: "manual",
          to: "queue",
          event: "go",
          kind: "completion",
          guards: [],
        },
      ],
    },
    {
      ...reviewDefinition,
      nodes: [
        ...reviewDefinition.nodes,
        { id: "future", label: "Future feature", kind: "activity" },
      ],
    },
    {
      ...reviewDefinition,
      edges: [
        ...reviewDefinition.edges,
        {
          id: "bad.guard",
          from: "manual",
          to: "queue",
          event: "go",
          kind: "feedback",
          guards: [""],
        },
      ],
    },
  ];
  for (const definition of invalid) assert.throws(() => validateWorkflowDefinition(definition));
});

test("knowledge runtime helpers return the exact topology edges exported to inspection", () => {
  assert.equal(knowledgeDefinition.initial, "discovery");
  let phase: KnowledgeNodeId = knowledgeDefinition.initial;
  const visited = new Set<string>();
  while (isKnowledgePhase(phase)) {
    assert(!visited.has(phase));
    visited.add(phase);
    const edge = forwardTransition(phase);
    assert(edge);
    assert.equal(findTransition(knowledgeDefinition, phase, edge.id), edge);
    assert.equal(
      knowledgeDefinition.edges.find((candidate) => candidate.id === edge.id),
      edge,
    );
    assert.equal(edge.to === "ready" ? undefined : edge.to, nextPhase(phase));
    phase = edge.to;
  }
  assert.equal(phase, "ready");
  assert.equal(forwardTransition("plan")?.kind, "completion");
  assert.deepEqual(visited, new Set(phases));
  assert(
    !knowledgeDefinition.nodes.some((node) =>
      ["implementation", "verify", "verification"].includes(node.id),
    ),
  );
  for (const edge of knowledgeDefinition.edges.filter((edge) => edge.kind === "feedback")) {
    assert(isKnowledgePhase(edge.from));
    assert(edge.reason);
    assert.equal(feedbackTransition(edge.from, edge.reason), edge);
  }
  assert.equal(feedbackTransition("discovery", "missing_context"), undefined);
  assert.equal(feedbackTransition("define", "infeasible_design"), undefined);
  assert.equal(feedbackTransition("plan", "unknown_reason"), undefined);
});

test("policy metadata and rework invalidation derive from the same definition", () => {
  for (const phase of phases) {
    const node = knowledgeDefinition.nodes.find((node) => node.id === phase);
    assert(node);
    assert.deepEqual(contracts[phase], { role: node.role, kind: node.artifactKind });
  }
  for (const [reason, target] of Object.entries(feedbackTargets)) {
    const edges = knowledgeDefinition.edges.filter((edge) => edge.reason === reason);
    assert(edges.length > 0);
    assert(edges.every((edge) => edge.to === target));
  }
  assert.deepEqual(phasesInvalidatedBy("design"), ["design", "breakdown", "plan"]);
  const reordered = defineWorkflow({
    ...knowledgeDefinition,
    nodes: [...knowledgeDefinition.nodes].reverse(),
    edges: [...knowledgeDefinition.edges].reverse(),
  });
  assert.deepEqual(
    reachableStates(reordered, "design", ["forward", "completion"]).filter(isKnowledgePhase),
    phasesInvalidatedBy("design"),
  );
});
