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

export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
    if (nodes.get(edge.from)?.kind === "terminal" && edge.kind !== "feedback")
      throw new Error("terminal workflow states may only have feedback edges");
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

export function findTransition<StateId extends string>(
  definition: WorkflowDefinition<StateId>,
  from: StateId,
  edgeId: string,
): WorkflowEdge<StateId> | undefined {
  return definition.edges.find((edge) => edge.from === from && edge.id === edgeId);
}

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
