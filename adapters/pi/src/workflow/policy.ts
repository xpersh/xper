import type { WorkflowPolicy, RemainingBudget } from "./types.js";

export type { Phase } from "./definition.js";
import { knowledgeDefinition, isKnowledgePhase, type Phase } from "./definition.js";

export const phases = Object.freeze(
  knowledgeDefinition.nodes.map((node) => node.id).filter(isKnowledgePhase),
);
export const contracts = Object.fromEntries(
  knowledgeDefinition.nodes
    .filter((node) => isKnowledgePhase(node.id))
    .map((node) => {
      if (!node.role || !node.artifactKind)
        throw new Error("knowledge activities need role and artifact metadata");
      return [node.id, { role: node.role, kind: node.artifactKind }];
    }),
) as Record<Phase, { role: string; kind: string }>;
export const feedbackTargets: Record<string, Phase> = {};
for (const edge of knowledgeDefinition.edges) {
  if (edge.kind !== "feedback" || !edge.reason || !isKnowledgePhase(edge.to)) continue;
  if (feedbackTargets[edge.reason] && feedbackTargets[edge.reason] !== edge.to)
    throw new Error("knowledge feedback reason has conflicting destinations");
  feedbackTargets[edge.reason] = edge.to;
}
Object.freeze(feedbackTargets);

export type Policy = Required<WorkflowPolicy>;
export function policyFrom(value: WorkflowPolicy): Policy {
  const policy: Policy = {
    maxAttempts: 32,
    maxTimeMs: 3600000,
    attemptTimeMs: 120000,
    maxConcurrency: 4,
    maxCostMicros: null,
    attemptCostMicros: 0,
    humanGates: [],
    ...value,
  };
  const known = new Set([
    "maxAttempts",
    "maxTimeMs",
    "attemptTimeMs",
    "maxConcurrency",
    "maxCostMicros",
    "attemptCostMicros",
    "humanGates",
  ]);
  if (
    Object.keys(value).some((key) => !known.has(key)) ||
    [policy.maxAttempts, policy.maxTimeMs, policy.attemptTimeMs, policy.maxConcurrency].some(
      (n) => !Number.isSafeInteger(n) || n <= 0,
    ) ||
    !Number.isSafeInteger(policy.attemptCostMicros) ||
    policy.attemptCostMicros < 0 ||
    policy.attemptTimeMs > policy.maxTimeMs ||
    (policy.maxCostMicros !== null &&
      (!Number.isSafeInteger(policy.maxCostMicros) ||
        policy.attemptCostMicros <= 0 ||
        policy.attemptCostMicros > policy.maxCostMicros)) ||
    !Array.isArray(policy.humanGates) ||
    policy.humanGates.some((p) => !phases.includes(p as Phase))
  ) {
    throw new Error("invalid workflow budgets or human gates");
  }
  return policy;
}
export function budgetRemaining(
  policy: Policy,
  startedAt: number,
  now: number,
  attempts: number,
): RemainingBudget {
  return {
    attempts: Math.max(0, policy.maxAttempts - attempts),
    timeMs: Math.max(0, policy.maxTimeMs - Math.max(0, now - startedAt)),
    costMicros:
      policy.maxCostMicros === null
        ? null
        : Math.max(0, policy.maxCostMicros - attempts * policy.attemptCostMicros),
    concurrency: policy.maxConcurrency,
  };
}
export function admit(policy: Policy, budget: RemainingBudget, running: number): void {
  if (!budget.attempts) throw new Error("run attempt budget exhausted");
  if (!budget.timeMs) throw new Error("run time budget exhausted");
  if (running >= policy.maxConcurrency) throw new Error("run concurrency budget exhausted");
  if (budget.costMicros !== null && budget.costMicros < policy.attemptCostMicros)
    throw new Error("run cost budget exhausted");
}
