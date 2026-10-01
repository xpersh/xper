import { invalid } from "../validation.js";
import { startAssignment } from "./assignment.js";
import { finishAttempt } from "./completion.js";
import { knowledgeDefinition } from "./definition.js";
import type { FactEmitter, KnowledgeEvent, Results, Transition, WorkflowFact } from "./events.js";
import { receiveDeliveryFeedback } from "./feedback.js";
import { evaluateGate } from "./gate.js";
import { recordUsage, recoverKnowledge, startKnowledge } from "./lifecycle.js";
import { workflowPosition } from "./selectors.js";
import type { WorkflowState } from "./state.js";

export function transitionKnowledge<E extends KnowledgeEvent>(
  previous: WorkflowState | null,
  event: E,
  now: number,
): Transition<Results[E["type"]]> {
  const facts: WorkflowFact[] = [];
  const fact: FactEmitter = (type, data) => {
    facts.push({ type, data });
  };
  const state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== knowledgeDefinition.id ||
      state.definition.version !== knowledgeDefinition.version)
  )
    invalid("unsupported workflow definition");
  const finish = (decision: {
    state: WorkflowState;
    result: Results[KnowledgeEvent["type"]];
  }): Transition<Results[E["type"]]> => {
    if (facts.length) {
      decision.state.revision++;
      fact("workflow.position", { ...workflowPosition(decision.state) });
    }
    return {
      state: decision.state,
      facts,
      result: structuredClone(decision.result) as Results[E["type"]],
    };
  };
  if (event.type === "run.start") return finish(startKnowledge(state, event, now, fact));
  if (!state) invalid("start a workflow first");
  switch (event.type) {
    case "assignment.start":
      return finish(startAssignment(state, event, now, fact));
    case "attempt.finish":
      return finish(finishAttempt(state, event, now, fact));
    case "delivery.feedback":
      return finish(receiveDeliveryFeedback(state, event, fact));
    case "gate.evaluate":
      return finish(evaluateGate(state, event, now, fact));
    case "session.recover":
      return finish(recoverKnowledge(state, fact));
    case "usage.record":
      return finish(recordUsage(state, event, fact));
  }
}
