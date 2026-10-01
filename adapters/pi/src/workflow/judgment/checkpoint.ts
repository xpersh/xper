import { commit, invalid, object } from "../validation.js";
import { verdicts } from "./contract.js";
import { judgmentDefinition } from "./definition.js";
import type { JudgmentState } from "./state.js";

export function decodeJudgment(value: unknown): JudgmentState | null {
  if (value === null) return null;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every(text) && new Set(v).size === v.length;
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    ![value.runId, value.instanceId, value.assignmentId].every(text) ||
    !object(value.definition) ||
    value.definition.id !== judgmentDefinition.id ||
    value.definition.version !== judgmentDefinition.version ||
    !object(value.evaluation) ||
    !object(value.attempts) ||
    !(value.report === null || object(value.report)) ||
    !(
      value.selection === null ||
      (object(value.selection) &&
        [
          value.selection.provider,
          value.selection.model,
          value.selection.context,
          value.selection.thinking,
        ].every(text))
    ) ||
    !(value.model === null || text(value.model)) ||
    (value.selection === null) === (value.model === null)
  )
    invalid("unsupported Judgment checkpoint");
  const evaluation = value.evaluation;
  const reference = (v: unknown) =>
    object(v) &&
    text(v.path) &&
    /^\.xper\/artifacts\/[a-zA-Z0-9-]+\.(md|json|log)$/.test(v.path) &&
    text(v.digest);
  if (
    !text(evaluation.planArtifactId) ||
    !strings(evaluation.incrementIds) ||
    !strings(evaluation.criterionIds) ||
    !commit(evaluation.baseCommit) ||
    !commit(evaluation.evaluatedCommit) ||
    evaluation.baseCommit === evaluation.evaluatedCommit ||
    !Array.isArray(evaluation.artifacts) ||
    !evaluation.artifacts.length ||
    !evaluation.artifacts.every(
      (artifact) =>
        reference(artifact) &&
        object(artifact) &&
        text(artifact.artifact_id) &&
        text(artifact.kind) &&
        artifact.version === 1,
    ) ||
    new Set(evaluation.artifacts.map((artifact) => artifact.artifact_id)).size !==
      evaluation.artifacts.length ||
    !Array.isArray(evaluation.logs) ||
    !evaluation.logs.every(reference) ||
    new Set(evaluation.logs.map((log) => log.path)).size !== evaluation.logs.length
  )
    invalid("invalid Judgment evidence references");
  const state = value as unknown as JudgmentState;
  let running = 0;
  let succeeded = 0;
  for (const [id, attempt] of Object.entries(state.attempts)) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(id) ||
      !object(attempt) ||
      !integer(attempt.startedAt) ||
      !integer(attempt.timeoutMs) ||
      attempt.timeoutMs < 1 ||
      attempt.artifactPath !== `.xper/artifacts/judgment-verdict-${id}.json` ||
      ![null, "succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
        attempt.outcome,
      )
    )
      invalid("invalid Judgment attempt");
    if (attempt.outcome === null) running++;
    if (attempt.outcome === "succeeded") succeeded++;
  }
  if (
    !Object.keys(state.attempts).length ||
    running > 1 ||
    succeeded !== (state.report ? 1 : 0) ||
    (state.report &&
      (running > 0 ||
        !text(state.report.artifact_id) ||
        !text(state.report.digest) ||
        state.report.kind !== "judgment_verdict" ||
        state.report.version !== 1 ||
        !verdicts.includes(state.report.verdict) ||
        state.attempts[state.report.attemptId]?.outcome !== "succeeded" ||
        state.attempts[state.report.attemptId]?.artifactPath !== state.report.path))
  )
    invalid("invalid Judgment completion");
  return structuredClone(state);
}
