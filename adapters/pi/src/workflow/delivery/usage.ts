import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { knowledgeChange, type CheckpointChange } from "../checkpoint/update.js";
import { implementationDefinition } from "../implementation/definition.js";
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
  const delivery = implementation ?? verification;
  if (!delivery) invalid("attempt is not registered");

  const data = usageData(attemptId, usage);
  return {
    state: checkpoint,
    facts: [{ type: "model.usage", data }],
    result: undefined,
    definition: implementation ? implementationDefinition : verificationDefinition,
    context: {
      runId: delivery.runId,
      instanceId: delivery.instanceId,
    },
  };
}
