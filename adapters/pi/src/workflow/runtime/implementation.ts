import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { implementationChange } from "../checkpoint/update.js";
import { admitImplementation, implementationInputs } from "../delivery/admission.js";
import { artifactInput } from "../delivery/artifacts.js";
import { assignmentBudget, assignmentHistory, runBudget } from "../delivery/budget.js";
import type { DeliveryFrontier } from "../delivery/frontier.js";
import { transitionImplementation } from "../implementation/machine.js";
import type { ImplementationAssignmentStarted } from "../types.js";
import { readRegisteredArtifact } from "./evidence.js";
import { prepareImplementationHandoff } from "./handoff.js";
import type { PreparedChange, WorkflowEffects } from "./ports.js";

export async function prepareImplementationAssignment(
  checkpoint: AdapterCheckpoint,
  frontier: Extract<DeliveryFrontier, { kind: "implementation" }> | null,
  nowBeforeEvidence: number,
  assignmentId: string | undefined,
  fallbackModel: string | undefined,
  effects: WorkflowEffects,
): Promise<PreparedChange<ImplementationAssignmentStarted>> {
  const knowledge = checkpoint.knowledge;
  const initialHandoff = !frontier
    ? await prepareImplementationHandoff(checkpoint, effects.readArtifact, nowBeforeEvidence)
    : null;
  const prepared = implementationInputs(checkpoint, frontier, initialHandoff);
  const { existing, planArtifact, plannedAssignment, inputs, latestImplementation } = prepared;
  for (const id of inputs) await readRegisteredArtifact(checkpoint, effects.readArtifact, id);
  const workspace = await effects.inspectWorkspace(effects.cwd);
  const { selection, model } = admitImplementation(
    checkpoint,
    prepared,
    initialHandoff,
    workspace,
    fallbackModel,
  );
  const now = effects.now();
  return {
    change: implementationChange(
      checkpoint,
      transitionImplementation(
        existing ?? null,
        {
          type: "assignment.start",
          runId: knowledge.run_id,
          instanceId: existing?.instanceId ?? effects.id(),
          attemptId: effects.id(),
          ...(assignmentId ? { assignmentId } : {}),
          planArtifactId: planArtifact.artifact_id,
          planDigest: planArtifact.digest,
          assignment: plannedAssignment,
          inputs,
          inputArtifacts: inputs.map((id) => artifactInput(checkpoint, id)),
          criteria:
            initialHandoff?.criteria ??
            existing?.assignment.criteria ??
            latestImplementation?.assignment.criteria ??
            [],
          verification:
            initialHandoff?.verification ??
            existing?.assignment.verification ??
            latestImplementation?.assignment.verification ??
            [],
          selection,
          model,
          baseCommit: existing?.baseCommit ?? workspace.head,
          ...(checkpoint.authorizedPlan?.reworkReportId
            ? { reworkReportId: checkpoint.authorizedPlan.reworkReportId }
            : {}),
          attemptTimeMs: knowledge.policy.attemptTimeMs,
          attemptCostMicros: knowledge.policy.attemptCostMicros,
          assignmentBudget: assignmentBudget(
            checkpoint,
            plannedAssignment,
            assignmentHistory(checkpoint, plannedAssignment, "implementation"),
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
