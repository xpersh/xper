import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { ImplementationState } from "../implementation/state.js";
import type { parseDocument } from "../knowledge/contracts.js";
import { WorkflowValidationError } from "../types.js";
import { invalid } from "../validation.js";
import { artifactInput } from "./artifacts.js";
import { runBudget } from "./budget.js";
import { satisfiedAssignmentArtifacts } from "./frontier.js";
import { verifiedDeliveryTip } from "./history.js";
import {
  selectNextImplementationHandoff,
  selectVerificationHandoff,
  validateLinks,
} from "./plan.js";

import type { ImplementationResult } from "../implementation/result.js";
export type KnowledgeDocuments = Partial<Record<string, ReturnType<typeof parseDocument>>>;
export function requireImplementationPlan(checkpoint: AdapterCheckpoint) {
  const knowledge = checkpoint.knowledge;
  if (knowledge.lifecycle.status !== "completed") invalid("the execution Plan is not sealed");
  const authorized = checkpoint.authorizedPlan;
  if (!authorized || knowledge.accepted.plan !== authorized.artifactId)
    invalid("the revised Plan requires /xper resume <commit> before delivery");
  return authorized;
}
export function requireVerificationPlan(
  checkpoint: AdapterCheckpoint,
  implementation: ImplementationState,
): string {
  const knowledge = checkpoint.knowledge;
  if (knowledge.lifecycle.status !== "completed") invalid("the execution Plan is not sealed");
  if (implementation.lifecycle.status !== "completed")
    invalid("the increment has not produced an implementation result");
  if (implementation.planArtifactId !== checkpoint.authorizedPlan?.artifactId)
    invalid("verification cannot use an implementation from a stale Plan");
  return implementation.lifecycle.artifactId;
}
export function implementationHandoff(
  checkpoint: AdapterCheckpoint,
  documents: KnowledgeDocuments,
  now: number,
) {
  const knowledge = checkpoint.knowledge;
  const authorized = requireImplementationPlan(checkpoint);
  const plan = documents.plan;
  if (plan?.output.kind !== "execution_plan")
    invalid("sealed Plan is unsupported; replan before delivery");
  try {
    const satisfied = satisfiedAssignmentArtifacts(checkpoint);
    validateLinks(plan.output, documents, runBudget(checkpoint, now), new Set(satisfied.keys()));
    const selection = selectNextImplementationHandoff(
      plan.output,
      documents,
      knowledge.routing,
      satisfied,
    );
    if (selection.status === "complete")
      invalid("all planned increments are verified; the run is ready for Judgment Day");
    if (selection.status === "blocked")
      invalid(
        `the next implementation is blocked by unverified Plan dependencies (${selection.unsatisfiedDependencyIds.join(", ")})`,
      );
    const planId = knowledge.accepted.plan;
    if (!planId) invalid("sealed Plan identity is unavailable");
    const planArtifact = knowledge.artifacts[planId];
    if (!planArtifact) invalid("sealed Plan artifact is unavailable");
    const inputs = [
      ...new Set([...Object.values(knowledge.accepted), ...selection.dependencyArtifactIds]),
    ];
    return {
      ...selection.handoff,
      planArtifact,
      inputs,
      inputArtifacts: inputs.map((id) => artifactInput(checkpoint, id)),
      expectedBaseCommit:
        verifiedDeliveryTip(
          checkpoint.implementations,
          checkpoint.verifications,
          planArtifact.artifact_id,
        ) ?? authorized.baseCommit,
    };
  } catch (error) {
    if (
      error instanceof WorkflowValidationError &&
      (error.message.startsWith("all planned increments") ||
        error.message.startsWith("the next implementation is blocked"))
    )
      throw error;
    invalid(
      `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid handoff"})`,
    );
  }
}
export function verificationHandoff(
  checkpoint: AdapterCheckpoint,
  implementation: ImplementationState,
  documents: KnowledgeDocuments,
  report: ImplementationResult,
) {
  const knowledge = checkpoint.knowledge;
  const implementationArtifactId = requireVerificationPlan(checkpoint, implementation);
  const plan = documents.plan;
  if (plan?.output.kind !== "execution_plan")
    invalid("sealed Plan is unsupported; replan before delivery");
  const implementationArtifact = implementation.artifacts[implementationArtifactId];
  if (!implementationArtifact) invalid("implementation result evidence is unavailable");

  try {
    const handoff = selectVerificationHandoff(
      plan.output,
      documents,
      knowledge.routing,
      implementation.assignment.id,
      implementation.incrementId,
    );
    const planId = knowledge.accepted.plan;
    if (!planId) invalid("sealed Plan identity is unavailable");
    const planArtifact = knowledge.artifacts[planId];
    if (!planArtifact) invalid("sealed Plan artifact is unavailable");
    const inputs = [...new Set([...implementation.assignment.inputs, implementationArtifactId])];
    const rootBaseCommit =
      checkpoint.implementations[implementation.incrementId]?.find(
        (candidate) => candidate.planArtifactId === implementation.planArtifactId,
      )?.baseCommit ?? implementation.baseCommit;
    return {
      ...handoff,
      planArtifact,
      inputs,
      inputArtifacts: inputs.map((id) => artifactInput(checkpoint, id)),
      implementation: {
        instanceId: implementation.instanceId,
        artifactId: implementationArtifactId,
        digest: implementationArtifact.digest,
        baseCommit: rootBaseCommit,
        evaluatedCommit: report.output.resultingCommit,
        testCommands: report.output.tests.map((test) => test.command),
      },
    };
  } catch (error) {
    invalid(
      `sealed Plan is unsupported; replan before verification (${error instanceof Error ? error.message : "invalid handoff"})`,
    );
  }
}
