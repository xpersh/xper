/** Serializable topology shared by the workflow runtime and future inspection views. */
export interface WorkflowNode<StateId extends string> {
  readonly id: StateId;
  readonly label: string;
  readonly kind: "activity" | "terminal";
  readonly role?: string;
  readonly artifactKind?: string;
}

export interface WorkflowEdge<StateId extends string> {
  readonly id: string;
  readonly from: StateId;
  readonly to: StateId;
  readonly event: string;
  readonly kind: "forward" | "feedback" | "completion";
  /** Human-readable conditions. The owning workflow evaluates them, never this data model. */
  readonly guards: readonly string[];
  readonly reason?: string;
}

export interface WorkflowDefinition<StateId extends string = string> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly initial: StateId;
  readonly nodes: readonly WorkflowNode<StateId>[];
  readonly edges: readonly WorkflowEdge<StateId>[];
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Check topology integrity without assuming phase names, a linear path, or a DAG. */
export function validateWorkflowDefinition<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
): void {
  if (
    definition.schemaVersion !== 1 ||
    !text(definition.id) ||
    !Number.isSafeInteger(definition.version) ||
    definition.version < 1
  )
    throw new Error("invalid workflow definition identity or version");
  if (
    !definition.nodes.length ||
    definition.nodes.some(
      (node) =>
        !text(node.id) ||
        !text(node.label) ||
        !["activity", "terminal"].includes(node.kind) ||
        (node.role !== undefined && !text(node.role)) ||
        (node.artifactKind !== undefined && !text(node.artifactKind)),
    )
  )
    throw new Error("invalid workflow node metadata");
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  if (nodes.size !== definition.nodes.length) throw new Error("duplicate workflow node ID");
  if (!nodes.has(definition.initial)) throw new Error("initial workflow state is not declared");
  const edges = new Set<string>();
  for (const edge of definition.edges) {
    if (!text(edge.id) || edges.has(edge.id))
      throw new Error("invalid or duplicate workflow edge ID");
    edges.add(edge.id);
    if (!nodes.has(edge.from) || !nodes.has(edge.to))
      throw new Error("workflow edge references an unknown state");
    if (nodes.get(edge.from)?.kind === "terminal")
      throw new Error("terminal workflow states cannot have outgoing edges");
    if (
      !text(edge.event) ||
      !["forward", "feedback", "completion"].includes(edge.kind) ||
      !Array.isArray(edge.guards) ||
      !edge.guards.every(text) ||
      (edge.reason !== undefined && !text(edge.reason))
    )
      throw new Error("invalid workflow edge metadata");
    if (edge.kind === "completion" && nodes.get(edge.to)?.kind !== "terminal")
      throw new Error("completion edges must enter a terminal state");
  }
  const reachable = new Set<StateId>([definition.initial]);
  for (;;) {
    const size = reachable.size;
    for (const edge of definition.edges) if (reachable.has(edge.from)) reachable.add(edge.to);
    if (reachable.size === size) break;
  }
  if (reachable.size !== nodes.size)
    throw new Error("workflow definition contains unreachable states");
}

/** Validate and freeze the data that both the runtime and the UI consume. */
export function defineWorkflow<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
): WorkflowDefinition<StateId> {
  validateWorkflowDefinition(definition);
  return Object.freeze({
    ...definition,
    nodes: Object.freeze(definition.nodes.map((node) => Object.freeze({ ...node }))),
    edges: Object.freeze(
      definition.edges.map((edge) =>
        Object.freeze({ ...edge, guards: Object.freeze([...edge.guards]) }),
      ),
    ),
  });
}

export function outgoingTransitions<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
  state: StateId,
  event?: string,
): readonly WorkflowEdge<StateId>[] {
  return definition.edges.filter(
    (edge) => edge.from === state && (event === undefined || edge.event === event),
  );
}

/** An edge identity is only valid at its declared source state. */
export function findTransition<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
  from: StateId,
  edgeId: string,
): WorkflowEdge<StateId> | undefined {
  return definition.edges.find((edge) => edge.from === from && edge.id === edgeId);
}

const knowledgeNodes = [
  {
    id: "discovery",
    label: "Discovery",
    kind: "activity",
    role: "discovery.explorer",
    artifactKind: "discovery_brief",
  },
  {
    id: "define",
    label: "Define",
    kind: "activity",
    role: "define.product",
    artifactKind: "definition_contract",
  },
  {
    id: "design",
    label: "Design",
    kind: "activity",
    role: "design.designer",
    artifactKind: "design_decisions",
  },
  {
    id: "breakdown",
    label: "Breakdown",
    kind: "activity",
    role: "breakdown.slicer",
    artifactKind: "story_map",
  },
  {
    id: "plan",
    label: "Plan",
    kind: "activity",
    role: "plan.planner",
    artifactKind: "execution_plan",
  },
  { id: "ready", label: "Execution plan ready", kind: "terminal" },
] as const;
export type KnowledgeNodeId = (typeof knowledgeNodes)[number]["id"];
export type Phase = Extract<(typeof knowledgeNodes)[number], { kind: "activity" }>["id"];

const gateGuards = [
  "The phase artifact and its inputs remain valid",
  "Run budgets allow advancement",
  "Any required human approval matches this artifact and visit",
] as const;
const feedbackGuards = [
  "Feedback names an earlier responsible phase",
  "Feedback evidence and input references remain valid",
  "Run budgets allow advancement",
] as const;

export const knowledgeDefinition = defineWorkflow<KnowledgeNodeId>({
  schemaVersion: 1,
  id: "pi.knowledge",
  version: 1,
  initial: "discovery",
  nodes: knowledgeNodes,
  edges: [
    {
      id: "gate.discovery.define",
      from: "discovery",
      to: "define",
      event: "gate.passed",
      kind: "forward",
      guards: gateGuards,
    },
    {
      id: "gate.define.design",
      from: "define",
      to: "design",
      event: "gate.passed",
      kind: "forward",
      guards: gateGuards,
    },
    {
      id: "gate.design.breakdown",
      from: "design",
      to: "breakdown",
      event: "gate.passed",
      kind: "forward",
      guards: gateGuards,
    },
    {
      id: "gate.breakdown.plan",
      from: "breakdown",
      to: "plan",
      event: "gate.passed",
      kind: "forward",
      guards: gateGuards,
    },
    {
      id: "gate.plan.ready",
      from: "plan",
      to: "ready",
      event: "gate.passed",
      kind: "completion",
      guards: gateGuards,
    },
    {
      id: "feedback.define.missing-context",
      from: "define",
      to: "discovery",
      event: "feedback",
      kind: "feedback",
      reason: "missing_context",
      guards: feedbackGuards,
    },
    {
      id: "feedback.design.missing-context",
      from: "design",
      to: "discovery",
      event: "feedback",
      kind: "feedback",
      reason: "missing_context",
      guards: feedbackGuards,
    },
    {
      id: "feedback.design.ambiguous-criteria",
      from: "design",
      to: "define",
      event: "feedback",
      kind: "feedback",
      reason: "ambiguous_criteria",
      guards: feedbackGuards,
    },
    {
      id: "feedback.breakdown.missing-context",
      from: "breakdown",
      to: "discovery",
      event: "feedback",
      kind: "feedback",
      reason: "missing_context",
      guards: feedbackGuards,
    },
    {
      id: "feedback.breakdown.ambiguous-criteria",
      from: "breakdown",
      to: "define",
      event: "feedback",
      kind: "feedback",
      reason: "ambiguous_criteria",
      guards: feedbackGuards,
    },
    {
      id: "feedback.breakdown.infeasible-design",
      from: "breakdown",
      to: "design",
      event: "feedback",
      kind: "feedback",
      reason: "infeasible_design",
      guards: feedbackGuards,
    },
    {
      id: "feedback.plan.missing-context",
      from: "plan",
      to: "discovery",
      event: "feedback",
      kind: "feedback",
      reason: "missing_context",
      guards: feedbackGuards,
    },
    {
      id: "feedback.plan.ambiguous-criteria",
      from: "plan",
      to: "define",
      event: "feedback",
      kind: "feedback",
      reason: "ambiguous_criteria",
      guards: feedbackGuards,
    },
    {
      id: "feedback.plan.infeasible-design",
      from: "plan",
      to: "design",
      event: "feedback",
      kind: "feedback",
      reason: "infeasible_design",
      guards: feedbackGuards,
    },
    {
      id: "feedback.plan.oversized-story",
      from: "plan",
      to: "breakdown",
      event: "feedback",
      kind: "feedback",
      reason: "oversized_story",
      guards: feedbackGuards,
    },
  ],
});

export function isKnowledgePhase(state: KnowledgeNodeId): state is Phase {
  return knowledgeDefinition.nodes.find((node) => node.id === state)?.kind === "activity";
}

/** Includes the explicit Plan-to-ready completion edge. */
export function forwardTransition(phase: Phase): WorkflowEdge<KnowledgeNodeId> | undefined {
  const transitions = outgoingTransitions(knowledgeDefinition, phase, "gate.passed");
  if (transitions.length > 1) throw new Error("knowledge gate has ambiguous transitions");
  return transitions[0];
}

export function nextPhase(phase: Phase): Phase | undefined {
  const next = forwardTransition(phase)?.to;
  return next !== undefined && isKnowledgePhase(next) ? next : undefined;
}

export function feedbackTransition(
  phase: Phase,
  reason: string,
): WorkflowEdge<KnowledgeNodeId> | undefined {
  const transitions = outgoingTransitions(knowledgeDefinition, phase, "feedback").filter(
    (edge) => edge.kind === "feedback" && edge.reason === reason,
  );
  if (transitions.length > 1) throw new Error("knowledge feedback has ambiguous transitions");
  return transitions[0];
}

/** Follow selected edge kinds without assuming ordered or linearly numbered nodes. */
export function reachableStates<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
  from: StateId,
  kinds: readonly WorkflowEdge<StateId>["kind"][],
): readonly StateId[] {
  if (!definition.nodes.some((node) => node.id === from))
    throw new Error("workflow state is not declared");
  const reached = new Set<StateId>([from]);
  const pending = [from];
  while (pending.length) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const edge of outgoingTransitions(definition, current)) {
      if (kinds.includes(edge.kind) && !reached.has(edge.to)) {
        reached.add(edge.to);
        pending.push(edge.to);
      }
    }
  }
  return [...reached];
}

/** Rework invalidates the target and its downstream knowledge evidence. */
export function phasesInvalidatedBy(target: Phase): readonly Phase[] {
  return reachableStates(knowledgeDefinition, target, ["forward", "completion"]).filter(
    isKnowledgePhase,
  );
}
