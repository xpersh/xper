import { judgmentDefinition } from "../judgment/definition.js";
import type { JudgmentTransition } from "../judgment/machine.js";
import { implementationDefinition } from "../implementation/definition.js";
import { knowledgeDefinition } from "../knowledge/definition.js";
import type { Transition } from "../knowledge/events.js";
import { invalid } from "../validation.js";
import { verificationDefinition } from "../verification/definition.js";
import type { AdapterCheckpoint } from "./types.js";

import type { ImplementationTransition } from "../implementation/events.js";
import type { VerificationTransition } from "../verification/events.js";
export interface CheckpointChange<Result> {
  state: AdapterCheckpoint;
  facts: Array<{ type: string; data: Record<string, unknown> }>;
  result: Result;
  definition:
    | typeof knowledgeDefinition
    | typeof implementationDefinition
    | typeof verificationDefinition
    | typeof judgmentDefinition;
  context: { runId: string; instanceId: string };
}
export function knowledgeChange<Result>(
  previous: AdapterCheckpoint | null,
  transition: Transition<Result>,
): CheckpointChange<Result> {
  let checkpoint = previous ? structuredClone(previous) : null;
  if (checkpoint) checkpoint.knowledge = transition.state;
  else
    checkpoint = {
      version: 7,
      closure: null,
      judgment: null,
      knowledge: transition.state,
      implementations: {},
      verifications: {},
      authorizedPlan: null,
      reconciliations: [],
    };

  if (
    transition.state.lifecycle.status === "completed" &&
    checkpoint.authorizedPlan === null &&
    checkpoint.reconciliations.length === 0 &&
    !Object.keys(checkpoint.implementations).length &&
    !Object.keys(checkpoint.verifications).length
  ) {
    const planId = transition.state.lifecycle.artifactId;
    const plan = transition.state.artifacts[planId];
    if (!plan) invalid("sealed Plan artifact is unavailable");
    checkpoint.authorizedPlan = {
      artifactId: planId,
      digest: plan.digest,
      baseCommit: null,
    };
  }

  return {
    state: checkpoint,
    facts: transition.facts,
    result: transition.result,
    definition: knowledgeDefinition,
    context: { runId: transition.state.run_id, instanceId: transition.state.instanceId },
  };
}
export function implementationChange<Result>(
  previous: AdapterCheckpoint,
  transition: ImplementationTransition<Result>,
): CheckpointChange<Result> {
  const checkpoint = structuredClone(previous);
  let history = checkpoint.implementations[transition.state.incrementId];
  if (!history) {
    history = [];
    checkpoint.implementations[transition.state.incrementId] = history;
  }
  const index = history.findIndex((state) => state.instanceId === transition.state.instanceId);
  if (index >= 0) history[index] = transition.state;
  else history.push(transition.state);

  return {
    state: checkpoint,
    facts: transition.facts,
    result: transition.result,
    definition: implementationDefinition,
    context: { runId: transition.state.runId, instanceId: transition.state.instanceId },
  };
}
export function verificationChange<Result>(
  previous: AdapterCheckpoint,
  transition: VerificationTransition<Result>,
): CheckpointChange<Result> {
  const checkpoint = structuredClone(previous);
  let history = checkpoint.verifications[transition.state.incrementId];
  if (!history) {
    history = [];
    checkpoint.verifications[transition.state.incrementId] = history;
  }
  const index = history.findIndex((state) => state.instanceId === transition.state.instanceId);
  if (index >= 0) history[index] = transition.state;
  else history.push(transition.state);

  return {
    state: checkpoint,
    facts: transition.facts,
    result: transition.result,
    definition: verificationDefinition,
    context: { runId: transition.state.runId, instanceId: transition.state.instanceId },
  };
}

export function judgmentChange<Result>(
  previous: AdapterCheckpoint,
  transition: JudgmentTransition<Result>,
): CheckpointChange<Result> {
  return {
    state: { ...previous, judgment: transition.state },
    facts: transition.facts,
    result: transition.result,
    definition: judgmentDefinition,
    context: { runId: transition.state.runId, instanceId: transition.state.instanceId },
  };
}
