import { invalid, object } from "../validation.js";
import { verificationDefinition } from "./definition.js";
import type { VerificationState } from "./state.js";
import {
  artifactPath,
  integer,
  knowledgeFeedbackReason,
  selection,
  sha,
  strings,
  text,
} from "./validation.js";

export function decodeVerificationState(value: unknown): VerificationState {
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.runId) ||
    !object(value.definition) ||
    value.definition.id !== verificationDefinition.id ||
    value.definition.version !== verificationDefinition.version ||
    !text(value.instanceId) ||
    !text(value.incrementId) ||
    !text(value.planArtifactId) ||
    !text(value.planDigest) ||
    !integer(value.startedAt) ||
    !object(value.implementation) ||
    !text(value.implementation.instanceId) ||
    !text(value.implementation.artifactId) ||
    !text(value.implementation.digest) ||
    !sha(value.implementation.baseCommit) ||
    !sha(value.implementation.evaluatedCommit) ||
    !strings(value.implementation.testCommands) ||
    !value.implementation.testCommands.length ||
    !object(value.assignment) ||
    !text(value.assignment.id) ||
    value.assignment.role !== "verify.verifier" ||
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
    !integer(value.attemptTimeMs) ||
    value.attemptTimeMs < 1 ||
    !integer(value.attemptCostMicros) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.lifecycle) ||
    !["active", "completed"].includes(String(value.lifecycle.status))
  )
    invalid("unsupported verification checkpoint");
  const state = value as unknown as VerificationState;
  const completedArtifactId =
    state.lifecycle.status === "completed" ? state.lifecycle.artifactId : null;
  const completedVerdict = state.lifecycle.status === "completed" ? state.lifecycle.verdict : null;
  if (
    new Set(state.assignment.inputs).size !== state.assignment.inputs.length ||
    new Set(state.assignment.criteria.map((criterion) => criterion.id)).size !==
      state.assignment.criteria.length ||
    new Set(state.assignment.attemptIds).size !== state.assignment.attemptIds.length ||
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
        (attempt.artifactId === null || Object.hasOwn(state.artifacts, attempt.artifactId)),
    ) ||
    !Object.entries(state.artifacts).every(
      ([artifactId, artifact]) =>
        artifact.artifact_id === artifactId &&
        Object.hasOwn(state.attempts, artifact.attemptId) &&
        state.attempts[artifact.attemptId]?.artifactId === artifactId &&
        artifact.kind === "verification_result" &&
        artifact.version === 1 &&
        artifactPath(artifact.path) &&
        text(artifact.digest) &&
        JSON.stringify(artifact.inputs) === JSON.stringify(state.assignment.inputs) &&
        ["verified", "rejected"].includes(artifact.verdict) &&
        artifact.evaluatedCommit === state.implementation.evaluatedCommit &&
        (artifact.knowledgeFeedbackReason === undefined ||
          (artifact.verdict === "rejected" &&
            knowledgeFeedbackReason(artifact.knowledgeFeedbackReason))),
    ) ||
    (completedArtifactId === null &&
      Object.values(state.attempts).some((attempt) => attempt.outcome === "succeeded")) ||
    (completedArtifactId !== null &&
      (!Object.hasOwn(state.artifacts, completedArtifactId) ||
        state.artifacts[completedArtifactId]?.verdict !== completedVerdict ||
        !Object.values(state.attempts).some(
          (attempt) =>
            attempt.outcome === "succeeded" && attempt.artifactId === completedArtifactId,
        )))
  )
    invalid("invalid verification checkpoint references");
  return structuredClone(state);
}
