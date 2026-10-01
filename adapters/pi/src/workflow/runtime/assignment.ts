import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { knowledgeChange } from "../checkpoint/update.js";
import { assertDeliveryReady, deliveryFrontier } from "../delivery/frontier.js";
import { transitionKnowledge } from "../knowledge/machine.js";
import type { StartedAssignment } from "../types.js";
import { readRegisteredArtifact } from "./evidence.js";
import type { PreparedChange, WorkflowEffects } from "./ports.js";

import { prepareImplementationAssignment } from "./implementation.js";
import { prepareVerificationAssignment } from "./verification.js";
export async function prepareAssignment(
  checkpoint: AdapterCheckpoint,
  assignmentId: string | undefined,
  fallbackModel: string | undefined,
  effects: WorkflowEffects,
): Promise<PreparedChange<StartedAssignment>> {
  const knowledge = checkpoint.knowledge;
  if (knowledge.lifecycle.status === "completed") {
    assertDeliveryReady(checkpoint);
    const nowBeforeEvidence = effects.now();
    const frontier = deliveryFrontier(checkpoint);
    if (frontier?.kind === "verification")
      return prepareVerificationAssignment(
        checkpoint,
        frontier,
        assignmentId,
        fallbackModel,
        effects,
      );
    return prepareImplementationAssignment(
      checkpoint,
      frontier,
      nowBeforeEvidence,
      assignmentId,
      fallbackModel,
      effects,
    );
  }
  const event = {
    type: "assignment.start" as const,
    ...(assignmentId ? { assignmentId } : {}),
    newAssignmentId: effects.id(),
    attemptId: effects.id(),
  };
  const next = transitionKnowledge(knowledge, event, effects.now());
  for (const input of next.result.inputArtifacts ?? [])
    await readRegisteredArtifact(checkpoint, effects.readArtifact, input.artifact_id);
  const now = effects.now();
  return {
    change: knowledgeChange(checkpoint, transitionKnowledge(checkpoint.knowledge, event, now)),
    now: now,
  };
}
