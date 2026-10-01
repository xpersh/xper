import type { GitWorkspace } from "../../execution/workspace.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { invalid } from "../validation.js";
import type { VerificationState } from "../verification/state.js";
import type { DeliveryFrontier } from "./frontier.js";
import type { implementationHandoff } from "./handoff.js";
export function implementationInputs(
  checkpoint: AdapterCheckpoint,
  frontier: Extract<DeliveryFrontier, { kind: "implementation" }> | null,
  initialHandoff: ReturnType<typeof implementationHandoff> | null,
) {
  const knowledge = checkpoint.knowledge;
  const activePlanId = checkpoint.authorizedPlan?.artifactId;
  const latestImplementation =
    frontier?.kind === "implementation" ? frontier.implementation : undefined;
  const existing =
    latestImplementation?.lifecycle.status === "active" ? latestImplementation : undefined;
  const rejected = frontier?.kind === "implementation" ? frontier.rejected : undefined;
  const rejectionArtifactId =
    rejected?.lifecycle.status === "completed" ? rejected.lifecycle.artifactId : undefined;
  const incrementId = initialHandoff?.incrementId ?? latestImplementation?.incrementId;
  if (!incrementId) invalid("implementation increment is unavailable");
  const implementationHistory = (checkpoint.implementations[incrementId] ?? []).filter(
    (candidate) => candidate.planArtifactId === activePlanId,
  );
  const planArtifact =
    initialHandoff?.planArtifact ??
    knowledge.artifacts[existing?.planArtifactId ?? latestImplementation?.planArtifactId ?? ""];
  if (!planArtifact) invalid("implementation handoff evidence is unavailable");
  const plannedAssignment =
    initialHandoff?.assignment ?? existing?.assignment ?? latestImplementation?.assignment;
  if (!plannedAssignment) invalid("implementation assignment is unavailable");
  const inputs = initialHandoff
    ? initialHandoff.inputs
    : existing
      ? existing.assignment.inputs
      : rejectionArtifactId && latestImplementation?.lifecycle.status === "completed"
        ? [
            ...new Set([
              ...latestImplementation.assignment.inputs,
              latestImplementation.lifecycle.artifactId,
              rejectionArtifactId,
            ]),
          ]
        : invalid("the next delivery assignment is not eligible");

  return {
    latestImplementation,
    existing,
    rejected,
    implementationHistory,
    planArtifact,
    plannedAssignment,
    inputs,
  };
}
export function admitImplementation(
  checkpoint: AdapterCheckpoint,
  prepared: ReturnType<typeof implementationInputs>,
  initialHandoff: ReturnType<typeof implementationHandoff> | null,
  workspace: Pick<GitWorkspace, "clean" | "head">,
  fallbackModel: string | undefined,
) {
  const knowledge = checkpoint.knowledge;
  const { existing, rejected, implementationHistory } = prepared;
  const lastAttemptId = existing?.assignment.attemptIds.at(-1);
  const interrupted = lastAttemptId
    ? existing?.attempts[lastAttemptId]?.outcome === "interrupted"
    : false;
  if (!existing && !workspace.clean)
    invalid(
      rejected
        ? "implementation rework requires a clean dedicated checkout"
        : "implementation requires an initially clean dedicated checkout",
    );
  if (existing && !interrupted && !workspace.clean)
    invalid("implementation retry requires a clean checkout");
  if (rejected && !existing && workspace.head !== rejected.implementation.evaluatedCommit)
    invalid("rework checkout revision does not match the rejected implementation");
  if (initialHandoff?.expectedBaseCommit && workspace.head !== initialHandoff.expectedBaseCommit)
    invalid("implementation checkout revision does not match the latest verified increment");
  const frozen = implementationHistory[0]?.assignment;
  const selection =
    frozen?.selection ?? knowledge.routing?.routes["implementation.driver"]?.[0] ?? null;
  const model = frozen?.model ?? (selection ? null : (fallbackModel ?? null));
  if (!selection && !model)
    invalid("implementation requires the active Pi model to freeze its selection");

  return { selection, model };
}
export function admitVerification(
  checkpoint: AdapterCheckpoint,
  verificationHistory: VerificationState[],
  evaluatedCommit: string,
  workspace: Pick<GitWorkspace, "clean" | "head">,
  fallbackModel: string | undefined,
) {
  const knowledge = checkpoint.knowledge;
  if (!workspace.clean) invalid("verification requires a clean dedicated checkout");
  if (workspace.head !== evaluatedCommit)
    invalid("verification checkout revision does not match the implementation result");
  const frozen = verificationHistory[0]?.assignment;
  const selection = frozen?.selection ?? knowledge.routing?.routes["verify.verifier"]?.[0] ?? null;
  const model = frozen?.model ?? (selection ? null : (fallbackModel ?? null));
  if (!selection && !model)
    invalid("verification requires the active Pi model to freeze its selection");

  return { selection, model };
}
