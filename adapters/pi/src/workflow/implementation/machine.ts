import { invalid } from "../validation.js";
import { startAssignment } from "./assignment.js";
import { finishAttempt } from "./completion.js";
import { implementationDefinition } from "./definition.js";
import type {
  FactEmitter,
  ImplementationEvent,
  ImplementationFact,
  ImplementationResultByEvent,
  ImplementationTransition,
} from "./events.js";
import { implementationPosition } from "./selectors.js";
import type { ImplementationState } from "./state.js";

export function transitionImplementation<E extends ImplementationEvent>(
  previous: ImplementationState | null,
  event: E,
  now: number,
): ImplementationTransition<ImplementationResultByEvent[E["type"]]> {
  const facts: ImplementationFact[] = [];
  const fact: FactEmitter = (type, data) => {
    facts.push({ type, data });
  };
  const state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== implementationDefinition.id ||
      ![1, 2].includes(state.definition.version))
  )
    invalid("unsupported implementation definition");
  const finish = (decision: {
    state: ImplementationState;
    result: ImplementationResultByEvent[ImplementationEvent["type"]];
  }): ImplementationTransition<ImplementationResultByEvent[E["type"]]> => {
    if (facts.length) {
      decision.state.revision++;
      fact("workflow.position", { ...implementationPosition(decision.state) });
    }
    return {
      state: decision.state,
      facts,
      result: structuredClone(decision.result) as ImplementationResultByEvent[E["type"]],
    };
  };
  if (event.type === "assignment.start") return finish(startAssignment(state, event, now, fact));
  if (!state) invalid("start an implementation flow first");
  if (event.type === "attempt.finish") return finish(finishAttempt(state, event, now, fact));
  for (const [attemptId, attempt] of Object.entries(state.attempts)) {
    if (attempt.outcome !== null) continue;
    attempt.outcome = "interrupted";
    fact("attempt.finished", {
      attemptId,
      assignmentId: state.assignment.id,
      outcome: "interrupted",
    });
  }
  return finish({ state, result: undefined });
}
