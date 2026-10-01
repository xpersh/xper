import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { verificationChange } from "../checkpoint/update.js";
import { admitVerification } from "../delivery/admission.js";
import { artifactInput } from "../delivery/artifacts.js";
import { assignmentBudget, assignmentHistory, runBudget } from "../delivery/budget.js";
import type { DeliveryFrontier } from "../delivery/frontier.js";
import type { VerificationAssignmentStarted } from "../types.js";
import { invalid } from "../validation.js";
import { transitionVerification } from "../verification/machine.js";
import { readRegisteredArtifact } from "./evidence.js";
import { prepareVerificationHandoff } from "./handoff.js";
import type { PreparedChange, WorkflowEffects } from "./ports.js";

export async function prepareVerificationAssignment(
  checkpoint: AdapterCheckpoint,
  frontier: Extract<DeliveryFrontier, { kind: "verification" }>,
  assignmentId: string | undefined,
  fallbackModel: string | undefined,
  effects: WorkflowEffects,
): Promise<PreparedChange<VerificationAssignmentStarted>> {
  const knowledge = checkpoint.knowledge;
  const activePlanId = checkpoint.authorizedPlan?.artifactId;
  const { implementation, verification: verificationForLatest } = frontier;
  const verificationHistory = (checkpoint.verifications[implementation.incrementId] ?? []).filter(
    (candidate) => candidate.planArtifactId === activePlanId,
  );
  const handoff = verificationForLatest
    ? {
        assignment: verificationForLatest.assignment,
        planArtifact: knowledge.artifacts[verificationForLatest.planArtifactId],
        inputs: verificationForLatest.assignment.inputs,
        inputArtifacts: verificationForLatest.assignment.inputs.map((id) =>
          artifactInput(checkpoint, id),
        ),
        criteria: verificationForLatest.assignment.criteria,
        verification: verificationForLatest.assignment.verification,
        implementation: verificationForLatest.implementation,
      }
    : await prepareVerificationHandoff(checkpoint, effects.readArtifact, implementation);
  if (!handoff.planArtifact) invalid("verification handoff evidence is unavailable");
  for (const id of handoff.inputs)
    await readRegisteredArtifact(checkpoint, effects.readArtifact, id);
  const workspace = await effects.inspectWorkspace(effects.cwd);
  const { selection, model } = admitVerification(
    checkpoint,
    verificationHistory,
    handoff.implementation.evaluatedCommit,
    workspace,
    fallbackModel,
  );
  const now = effects.now();
  return {
    change: verificationChange(
      checkpoint,
      transitionVerification(
        verificationForLatest ?? null,
        {
          type: "assignment.start",
          runId: knowledge.run_id,
          instanceId: verificationForLatest?.instanceId ?? effects.id(),
          attemptId: effects.id(),
          ...(assignmentId ? { assignmentId } : {}),
          planArtifactId: handoff.planArtifact.artifact_id,
          planDigest: handoff.planArtifact.digest,
          implementation: handoff.implementation,
          assignment: handoff.assignment,
          inputs: handoff.inputs,
          inputArtifacts: handoff.inputArtifacts,
          criteria: handoff.criteria,
          verification: handoff.verification,
          selection,
          model,
          attemptTimeMs: knowledge.policy.attemptTimeMs,
          attemptCostMicros: knowledge.policy.attemptCostMicros,
          assignmentBudget: assignmentBudget(
            checkpoint,
            handoff.assignment,
            assignmentHistory(checkpoint, handoff.assignment, "verification"),
            now,
          ),
          globalBudget: runBudget(checkpoint, now),
        },
        now,
      ),
    ),
    now: now,
  };
}
