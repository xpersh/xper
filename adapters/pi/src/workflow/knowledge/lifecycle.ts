import { contracts, policyFrom } from "../policy.js";
import type { WorkflowPolicy } from "../types.js";
import { usageData } from "../usage.js";
import { invalid } from "../validation.js";
import { knowledgeDefinition } from "./definition.js";
import type { FactEmitter, KnowledgeEvent, Results } from "./events.js";
import { currentVisit, type WorkflowState } from "./state.js";

export function startKnowledge(
  state: WorkflowState | null,
  event: Extract<KnowledgeEvent, { type: "run.start" }>,
  now: number,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["run.start"] } {
  if (state)
    return {
      state,
      result: { runId: state.run_id, phase: currentVisit(state).phase, resumed: true },
    };
  const { routing, adapterConfig } = event.configuration;
  const policy = policyFrom(structuredClone(event.policy ?? (adapterConfig as WorkflowPolicy)));
  if (routing && !routing.routes[contracts.discovery.role]?.length)
    invalid("active profile has no Discovery route");
  const initial = knowledgeDefinition.initial;
  if (initial === "ready") invalid("knowledge initial state must be an activity");
  state = {
    version: 3,
    revision: 0,
    run_id: event.runId,
    instanceId: event.instanceId,
    definition: { id: knowledgeDefinition.id, version: knowledgeDefinition.version },
    startedAt: now,
    routing: structuredClone(routing),
    policy,
    visits: [{ id: event.visitId, phase: initial }],
    assignments: {},
    attempts: {},
    artifacts: {},
    imports: {},
    accepted: {},
    feedback: null,
    lifecycle: { status: "active" },
  };
  fact("run.started", {
    workflow: `${state.definition.id}.v${state.definition.version}`,
    objectiveHash: event.objectiveHash,
    profile: routing?.profile ?? null,
    context: routing?.context ?? null,
  });
  fact("phase.entered", { phase: "discovery", visitId: event.visitId });
  return { state, result: { runId: state.run_id, phase: "discovery", resumed: false } };
}

export function recoverKnowledge(
  state: WorkflowState,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["session.recover"] } {
  for (const [attemptId, attempt] of Object.entries(state.attempts)) {
    if (attempt.outcome !== null) continue;
    attempt.outcome = "interrupted";
    fact("attempt.finished", {
      attemptId,
      outcome: "interrupted",
      assignmentId: attempt.assignmentId,
    });
  }
  return { state, result: undefined };
}

export function recordUsage(
  state: WorkflowState,
  event: Extract<KnowledgeEvent, { type: "usage.record" }>,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["usage.record"] } {
  if (!state.attempts[event.attemptId]) invalid("attempt is not registered");
  const data = usageData(event.attemptId, event.usage);
  fact("model.usage", data);
  return { state, result: undefined };
}
