import type { GitWorkspace } from "../../execution/workspace.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { CheckpointChange } from "../checkpoint/update.js";
import { knowledgeDefinition } from "../knowledge/definition.js";
import type { DeliveryResumed } from "../types.js";
import { invalid } from "../validation.js";

export function validateResumeRequest(
  checkpoint: AdapterCheckpoint,
  revision: string,
): DeliveryResumed | null {
  validateResumeRevision(revision);

  const reconciliation = checkpoint.reconciliations.at(-1);
  if (!reconciliation) invalid("there is no revised Plan awaiting resumption");
  if (reconciliation.status === "resumed") {
    if (reconciliation.resumeCommit !== revision)
      invalid("delivery has already resumed from a different checkout revision");
    return {
      planArtifactId: reconciliation.revisedPlanArtifactId as string,
      checkoutRevision: revision,
      replayed: true,
    };
  }
  if (
    reconciliation.status !== "awaiting_resume" ||
    !reconciliation.revisedPlanArtifactId ||
    checkpoint.knowledge.lifecycle.status !== "completed" ||
    checkpoint.knowledge.lifecycle.artifactId !== reconciliation.revisedPlanArtifactId
  )
    invalid("finish and seal the Knowledge revisit before resuming delivery");

  return null;
}
export function resumeChange(
  previous: AdapterCheckpoint,
  revision: string,
  workspace: Pick<GitWorkspace, "clean" | "head">,
): CheckpointChange<DeliveryResumed> {
  const replay = validateResumeRequest(previous, revision);
  if (replay)
    return {
      state: previous,
      facts: [],
      result: replay,
      definition: knowledgeDefinition,
      context: { runId: previous.knowledge.run_id, instanceId: previous.knowledge.instanceId },
    };
  const checkpoint = structuredClone(previous);
  const reconciliation = checkpoint.reconciliations.at(-1);
  if (!reconciliation?.revisedPlanArtifactId) invalid("no revised Plan is awaiting resumption");
  if (!workspace.clean) invalid("delivery resumption requires a clean dedicated checkout");
  if (workspace.head !== revision)
    invalid("delivery resumption revision does not match the checkout HEAD");
  const plan = checkpoint.knowledge.artifacts[reconciliation.revisedPlanArtifactId];
  if (!plan) invalid("revised Plan artifact is unavailable");
  reconciliation.status = "resumed";
  reconciliation.resumeCommit = revision;
  checkpoint.authorizedPlan = {
    artifactId: reconciliation.revisedPlanArtifactId,
    digest: plan.digest,
    baseCommit: revision,
  };

  return {
    state: checkpoint,
    facts: [
      {
        type: "delivery.resumed",
        data: {
          verificationArtifactId: reconciliation.verificationArtifactId,
          previousPlanArtifactId: reconciliation.previousPlanArtifactId,
          planArtifactId: reconciliation.revisedPlanArtifactId,
          checkoutRevision: revision,
        },
      },
    ],
    result: {
      planArtifactId: reconciliation.revisedPlanArtifactId,
      checkoutRevision: revision,
      replayed: false,
    },
    definition: knowledgeDefinition,
    context: { runId: checkpoint.knowledge.run_id, instanceId: checkpoint.knowledge.instanceId },
  };
}

export function validateResumeRevision(revision: string): void {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision))
    invalid("provide a full lowercase Git commit hash");
}
