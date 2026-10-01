import { prepareJudgmentSettlement } from "./judgment.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { implementationChange, knowledgeChange, verificationChange } from "../checkpoint/update.js";
import { transitionImplementation } from "../implementation/machine.js";
import type { Evidence } from "../knowledge/events.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import { completionNeedsEvidence } from "../knowledge/selectors.js";
import type { AttemptFinished, FinishAttempt } from "../types.js";
import { invalid } from "../validation.js";
import { transitionVerification } from "../verification/machine.js";
import type { VerificationState } from "../verification/state.js";
import { readRegisteredArtifact } from "./evidence.js";
import type { PreparedChange, WorkflowEffects } from "./ports.js";
export interface PreparedSettlement extends PreparedChange<AttemptFinished> {
  feedbackSource?: VerificationState;
}
export async function prepareSettlement(
  checkpoint: AdapterCheckpoint,
  result: FinishAttempt,
  effects: WorkflowEffects,
): Promise<PreparedSettlement> {
  if (checkpoint.judgment?.attempts[result.attemptId])
    return prepareJudgmentSettlement(checkpoint, result, effects);
  const implementation = Object.values(checkpoint.implementations)
    .flat()
    .find((candidate) => Object.hasOwn(candidate.attempts, result.attemptId));
  const verification = Object.values(checkpoint.verifications)
    .flat()
    .find((candidate) => Object.hasOwn(candidate.attempts, result.attemptId));
  const now = effects.now();
  if (verification) {
    let evidence: Evidence | undefined;
    if ("artifactPath" in result) {
      try {
        evidence = await effects.readArtifact(result.artifactPath);
        for (const input of verification.assignment.inputs)
          await readRegisteredArtifact(checkpoint, effects.readArtifact, input);
      } catch (error) {
        invalid(error instanceof Error ? error.message : "invalid verification evidence");
      }
    }
    const transition = transitionVerification(
      verification,
      {
        type: "attempt.finish",
        result,
        artifactId: effects.id(),
        ...(evidence ? { evidence } : {}),
      },
      now,
    );
    return {
      change: verificationChange(checkpoint, transition),
      now,
      feedbackSource: transition.state,
    };
  }
  if (implementation) {
    let evidence: Evidence | undefined;
    if ("artifactPath" in result) {
      try {
        evidence = await effects.readArtifact(result.artifactPath);
        for (const input of implementation.assignment.inputs)
          await readRegisteredArtifact(checkpoint, effects.readArtifact, input);
      } catch (error) {
        invalid(error instanceof Error ? error.message : "invalid implementation evidence");
      }
    }
    return {
      change: implementationChange(
        checkpoint,
        transitionImplementation(
          implementation,
          {
            type: "attempt.finish",
            result,
            artifactId: effects.id(),
            ...(evidence ? { evidence } : {}),
          },
          now,
        ),
      ),
      now,
    };
  }
  const state = checkpoint.knowledge;
  let evidence: Evidence | undefined;
  if (completionNeedsEvidence(state, result, now) && result.outcome === "succeeded") {
    try {
      evidence = await effects.readArtifact(result.artifactPath);
      const attempt = state.attempts[result.attemptId];
      const assignment = attempt && state.assignments[attempt.assignmentId];
      if (!assignment) invalid("assignment is not registered");
      for (const input of assignment.inputs)
        await readRegisteredArtifact(checkpoint, effects.readArtifact, input);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "invalid artifact");
    }
  }
  return {
    change: knowledgeChange(
      checkpoint,
      transitionKnowledge(
        state,
        {
          type: "attempt.finish",
          result,
          artifactId: effects.id(),
          ...(evidence ? { evidence } : {}),
        },
        now,
      ),
    ),
    now,
  };
}
