import { invalid, object } from "../validation.js";
import { implementationDefinition } from "./definition.js";
import type { ImplementationState } from "./state.js";
import { artifactPath, integer, selection, sha, strings, text } from "./validation.js";

export function decodeImplementationState(value: unknown): ImplementationState {
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.runId) ||
    !object(value.definition) ||
    value.definition.id !== implementationDefinition.id ||
    !(value.definition.version === 1 || value.definition.version === 2) ||
    (value.definition.version === 1
      ? value.reworkReportId !== undefined
      : !text(value.reworkReportId)) ||
    !text(value.instanceId) ||
    !text(value.incrementId) ||
    !text(value.planArtifactId) ||
    !text(value.planDigest) ||
    !integer(value.startedAt) ||
    !sha(value.baseCommit) ||
    !object(value.assignment) ||
    !text(value.assignment.id) ||
    value.assignment.role !== "implementation.driver" ||
    value.assignment.incrementId !== value.incrementId ||
    !strings(value.assignment.dependencies) ||
    !text(value.assignment.workspace) ||
    !strings(value.assignment.resources) ||
    !integer(value.assignment.maxAttempts) ||
    value.assignment.maxAttempts < 1 ||
    !integer(value.assignment.maxTimeMs) ||
    value.assignment.maxTimeMs < 1 ||
    !integer(value.assignment.maxCostMicros) ||
    !strings(value.assignment.inputs) ||
    !value.assignment.inputs.length ||
    !Array.isArray(value.assignment.criteria) ||
    !value.assignment.criteria.length ||
    !value.assignment.criteria.every(
      (criterion) =>
        object(criterion) &&
        text(criterion.id) &&
        text(criterion.behavior) &&
        text(criterion.example),
    ) ||
    !strings(value.assignment.verification) ||
    !value.assignment.verification.length ||
    !selection(value.assignment.selection) ||
    !(value.assignment.model === null || text(value.assignment.model)) ||
    (value.assignment.selection === null) === (value.assignment.model === null) ||
    !strings(value.assignment.attemptIds) ||
    new Set(value.assignment.attemptIds).size !== value.assignment.attemptIds.length ||
    !integer(value.attemptTimeMs) ||
    value.attemptTimeMs < 1 ||
    !integer(value.attemptCostMicros) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.lifecycle) ||
    !["active", "completed"].includes(String(value.lifecycle.status))
  )
    invalid("unsupported implementation checkpoint");
  const state = value as unknown as ImplementationState;
  const completedArtifactId =
    state.lifecycle.status === "completed" ? state.lifecycle.artifactId : null;
  if (
    new Set(state.assignment.inputs).size !== state.assignment.inputs.length ||
    new Set(state.assignment.criteria.map((criterion) => criterion.id)).size !==
      state.assignment.criteria.length ||
    Object.keys(state.attempts).length !== state.assignment.attemptIds.length ||
    !state.assignment.attemptIds.every((id) => Object.hasOwn(state.attempts, id)) ||
    !Object.entries(state.attempts).every(
      ([attemptId, attempt]) =>
        text(attemptId) &&
        integer(attempt.startedAt) &&
        integer(attempt.timeoutMs) &&
        attempt.timeoutMs > 0 &&
        (attempt.outcome === null ||
          ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
            attempt.outcome,
          )) &&
        artifactPath(attempt.artifactPath) &&
        selection(attempt.selection) &&
        JSON.stringify(attempt.selection) === JSON.stringify(state.assignment.selection) &&
        attempt.model === state.assignment.model &&
        (attempt.artifactId === null || Object.hasOwn(state.artifacts, attempt.artifactId)) &&
        state.assignment.attemptIds.includes(attemptId),
    ) ||
    !Object.entries(state.artifacts).every(
      ([artifactId, artifact]) =>
        artifact.artifact_id === artifactId &&
        Object.hasOwn(state.attempts, artifact.attemptId) &&
        state.attempts[artifact.attemptId]?.artifactId === artifactId &&
        artifact.kind === "implementation_result" &&
        artifact.version === 1 &&
        artifactPath(artifact.path) &&
        text(artifact.digest) &&
        JSON.stringify(artifact.inputs) === JSON.stringify(state.assignment.inputs) &&
        (artifact.resultingCommit === undefined || sha(artifact.resultingCommit)),
    ) ||
    (completedArtifactId === null &&
      Object.values(state.attempts).some((attempt) => attempt.outcome === "succeeded")) ||
    (completedArtifactId !== null &&
      (!Object.hasOwn(state.artifacts, completedArtifactId) ||
        !Object.values(state.attempts).some(
          (attempt) =>
            attempt.outcome === "succeeded" && attempt.artifactId === completedArtifactId,
        )))
  )
    invalid("invalid implementation checkpoint references");
  return structuredClone(state);
}
