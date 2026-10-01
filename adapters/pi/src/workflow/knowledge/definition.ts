import type { WorkflowEdge } from "../graph.js";

import { defineWorkflow, outgoingTransitions, reachableStates } from "../graph.js";

export const knowledgeNodes = [
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

export const gateGuards = [
  "The phase artifact and its inputs remain valid",
  "Run budgets allow advancement",
  "Any required human approval matches this artifact and visit",
] as const;

export const feedbackGuards = [
  "Feedback names an earlier responsible phase",
  "Feedback evidence and input references remain valid",
  "Run budgets allow advancement",
] as const;

export const knowledgeDefinition = defineWorkflow<KnowledgeNodeId>({
  schemaVersion: 1,
  id: "pi.knowledge",
  version: 2,
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
    {
      id: "feedback.ready.ambiguous-criteria",
      from: "ready",
      to: "define",
      event: "feedback",
      kind: "feedback",
      reason: "ambiguous_criteria",
      guards: feedbackGuards,
    },
    {
      id: "feedback.ready.infeasible-design",
      from: "ready",
      to: "design",
      event: "feedback",
      kind: "feedback",
      reason: "infeasible_design",
      guards: feedbackGuards,
    },
  ],
});

export function isKnowledgePhase(state: KnowledgeNodeId): state is Phase {
  return knowledgeDefinition.nodes.find((node) => node.id === state)?.kind === "activity";
}

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
  phase: KnowledgeNodeId,
  reason: string,
): WorkflowEdge<KnowledgeNodeId> | undefined {
  const transitions = outgoingTransitions(knowledgeDefinition, phase, "feedback").filter(
    (edge) => edge.kind === "feedback" && edge.reason === reason,
  );
  if (transitions.length > 1) throw new Error("knowledge feedback has ambiguous transitions");
  return transitions[0];
}

export function phasesInvalidatedBy(target: Phase): readonly Phase[] {
  return reachableStates(knowledgeDefinition, target, ["forward", "completion"]).filter(
    isKnowledgePhase,
  );
}
