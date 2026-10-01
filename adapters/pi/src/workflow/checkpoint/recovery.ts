import { transitionJudgment } from "../judgment/machine.js";
import { judgmentChange } from "./update.js";
import { transitionImplementation } from "../implementation/machine.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import { transitionVerification } from "../verification/machine.js";
import type { AdapterCheckpoint } from "./types.js";
import {
  implementationChange,
  knowledgeChange,
  verificationChange,
  type CheckpointChange,
} from "./update.js";

/** Preserve per-flow commit boundaries while recovering only recorded local work. */
export function* recoveryChanges(
  checkpoint: AdapterCheckpoint,
  now: number,
): Generator<CheckpointChange<undefined>> {
  let change = knowledgeChange(
    checkpoint,
    transitionKnowledge(checkpoint.knowledge, { type: "session.recover" }, now),
  );
  yield change;
  let current = change.state;
  for (const history of Object.values(current.implementations))
    for (const state of history) {
      change = implementationChange(
        current,
        transitionImplementation(state, { type: "session.recover" }, now),
      );
      yield change;
      current = change.state;
    }
  for (const history of Object.values(current.verifications))
    for (const state of history) {
      change = verificationChange(
        current,
        transitionVerification(state, { type: "session.recover" }, now),
      );
      yield change;
      current = change.state;
    }
  if (current.judgment)
    yield judgmentChange(
      current,
      transitionJudgment(current.judgment, { type: "session.recover" }, now),
    );
}
