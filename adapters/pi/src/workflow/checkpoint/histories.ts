import { decodeImplementationState } from "../implementation/checkpoint.js";
import type { ImplementationState } from "../implementation/state.js";
import type { WorkflowState } from "../knowledge/state.js";
import { WorkflowValidationError } from "../types.js";
import { decodeVerificationState } from "../verification/checkpoint.js";
import type { VerificationState } from "../verification/state.js";
import { validateHistoryReferences } from "./references.js";
export function decodeHistories(
  knowledge: WorkflowState,
  implementationValue: Record<string, unknown>,
  verificationValue: Record<string, unknown>,
) {
  const implementations: Record<string, ImplementationState[]> = {};
  const verifications: Record<string, VerificationState[]> = {};
  const instanceIds = new Set<string>([knowledge.instanceId]);
  const attemptIds = new Set(Object.keys(knowledge.attempts));
  const artifactIds = new Set(Object.keys(knowledge.artifacts));
  for (const [incrementId, history] of Object.entries(implementationValue)) {
    if (!Array.isArray(history) || !history.length)
      throw new WorkflowValidationError("invalid implementation checkpoint history");
    implementations[incrementId] = history.map((entry) => {
      const decoded = decodeImplementationState(entry);
      const plan = knowledge.artifacts[decoded.planArtifactId];
      if (
        decoded.incrementId !== incrementId ||
        decoded.runId !== knowledge.run_id ||
        !plan ||
        plan.digest !== decoded.planDigest ||
        instanceIds.has(decoded.instanceId)
      )
        throw new WorkflowValidationError("invalid implementation checkpoint identity");
      instanceIds.add(decoded.instanceId);
      for (const attemptId of Object.keys(decoded.attempts)) {
        if (attemptIds.has(attemptId))
          throw new WorkflowValidationError("duplicate delivery attempt identity");
        attemptIds.add(attemptId);
      }
      for (const artifactId of Object.keys(decoded.artifacts)) {
        if (artifactIds.has(artifactId))
          throw new WorkflowValidationError("duplicate delivery artifact identity");
        artifactIds.add(artifactId);
      }
      return decoded;
    });
  }
  for (const [incrementId, history] of Object.entries(verificationValue)) {
    if (!Array.isArray(history) || !history.length)
      throw new WorkflowValidationError("invalid verification checkpoint history");
    verifications[incrementId] = history.map((entry) => {
      const decoded = decodeVerificationState(entry);
      const plan = knowledge.artifacts[decoded.planArtifactId];
      const implementation = implementations[incrementId]?.find(
        (candidate) => candidate.instanceId === decoded.implementation.instanceId,
      );
      const firstForPlan = implementations[incrementId]?.find(
        (candidate) => candidate.planArtifactId === decoded.planArtifactId,
      );
      const artifact = implementation?.artifacts[decoded.implementation.artifactId];
      if (
        decoded.incrementId !== incrementId ||
        decoded.runId !== knowledge.run_id ||
        !plan ||
        plan.digest !== decoded.planDigest ||
        !implementation ||
        implementation.planArtifactId !== decoded.planArtifactId ||
        implementation.lifecycle.status !== "completed" ||
        implementation.lifecycle.artifactId !== decoded.implementation.artifactId ||
        !artifact ||
        artifact.digest !== decoded.implementation.digest ||
        decoded.implementation.baseCommit !== firstForPlan?.baseCommit ||
        (artifact.resultingCommit !== undefined &&
          artifact.resultingCommit !== decoded.implementation.evaluatedCommit) ||
        instanceIds.has(decoded.instanceId)
      )
        throw new WorkflowValidationError("invalid verification checkpoint identity");
      instanceIds.add(decoded.instanceId);
      for (const attemptId of Object.keys(decoded.attempts)) {
        if (attemptIds.has(attemptId))
          throw new WorkflowValidationError("duplicate delivery attempt identity");
        attemptIds.add(attemptId);
      }
      for (const artifactId of Object.keys(decoded.artifacts)) {
        if (artifactIds.has(artifactId))
          throw new WorkflowValidationError("duplicate delivery artifact identity");
        artifactIds.add(artifactId);
      }
      return decoded;
    });
  }

  validateHistoryReferences(knowledge, implementations, verifications, artifactIds);
  return { implementations, verifications };
}
