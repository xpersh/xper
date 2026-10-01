import { judgmentDefinition } from "../judgment/definition.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { knowledgeChange, type CheckpointChange } from "../checkpoint/update.js";
import { definitionForImplementation } from "../implementation/definition.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import type { ModelUsage } from "../types.js";
import { invalid } from "../validation.js";
import { verificationDefinition } from "../verification/definition.js";

import { usageData } from "../usage.js";
export function usageChange(
  checkpoint: AdapterCheckpoint,
  attemptId: string,
  usage: ModelUsage,
  now: number,
): CheckpointChange<undefined> {
  if (checkpoint.knowledge.attempts[attemptId])
    return knowledgeChange(
      checkpoint,
      transitionKnowledge(checkpoint.knowledge, { type: "usage.record", attemptId, usage }, now),
    );
  const implementation = Object.values(checkpoint.implementations)
    .flat()
    .find((candidate) => Object.hasOwn(candidate.attempts, attemptId));
  const verification = Object.values(checkpoint.verifications)
    .flat()
    .find((candidate) => Object.hasOwn(candidate.attempts, attemptId));
  const judgment = checkpoint.judgment?.attempts[attemptId]
    ? checkpoint.judgment
    : checkpoint.judgmentHistory.find((entry) => Object.hasOwn(entry.state.attempts, attemptId))
        ?.state;
  const delivery = implementation ?? verification ?? judgment;
  if (!delivery) invalid("attempt is not registered");

  const data = usageData(attemptId, usage);
  return {
    state: checkpoint,
    facts: [{ type: "model.usage", data }],
    result: undefined,
    definition: judgment
      ? judgmentDefinition
      : implementation
        ? definitionForImplementation(implementation.definition.version)
        : verificationDefinition,
    context: {
      runId: delivery.runId,
      instanceId: delivery.instanceId,
    },
  };
}
