import { invalid } from "../validation.js";
import { startAssignment } from "./assignment.js";
import { finishAttempt } from "./completion.js";
import { verificationDefinition } from "./definition.js";
import type {
  FactEmitter,
  Results,
  VerificationEvent,
  VerificationFact,
  VerificationTransition,
} from "./events.js";
import { verificationPosition } from "./selectors.js";
import type { VerificationState } from "./state.js";

export function transitionVerification<E extends VerificationEvent>(
  previous: VerificationState | null,
  event: E,
  now: number,
): VerificationTransition<Results[E["type"]]> {
  const facts: VerificationFact[] = [];
  const fact: FactEmitter = (type, data) => {
    facts.push({ type, data });
  };
  const state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== verificationDefinition.id ||
      state.definition.version !== verificationDefinition.version)
  )
    invalid("unsupported verification definition");
  const finish = (decision: {
    state: VerificationState;
    result: Results[VerificationEvent["type"]];
  }): VerificationTransition<Results[E["type"]]> => {
    if (facts.length) {
      decision.state.revision++;
      fact("workflow.position", { ...verificationPosition(decision.state) });
    }
    return {
      state: decision.state,
      facts,
      result: structuredClone(decision.result) as Results[E["type"]],
    };
  };
  if (event.type === "assignment.start") return finish(startAssignment(state, event, now, fact));
  if (!state) invalid("start a verification flow first");
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
