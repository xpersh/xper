import { phases, policyFrom, type Phase } from "../policy.js";
import { WorkflowValidationError } from "../types.js";
import { object } from "../validation.js";
import { knowledgeDefinition } from "./definition.js";
import type { ImportedArtifact, LegacyWorkflowState, WorkflowState } from "./state.js";

export const textValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validLegacyState(
  value: unknown,
  imports: Record<string, ImportedArtifact> = {},
): value is LegacyWorkflowState {
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const selection = (v: unknown) =>
    v === null || (object(v) && [v.context, v.provider, v.model, v.thinking].every(text));
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.run_id) ||
    !integer(value.startedAt) ||
    typeof value.ready !== "boolean" ||
    !object(value.policy) ||
    !Array.isArray(value.visits) ||
    !value.visits.length ||
    !object(value.assignments) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.accepted)
  )
    return false;
  try {
    policyFrom(value.policy);
  } catch {
    return false;
  }
  if (
    value.routing !== null &&
    (!object(value.routing) ||
      !text(value.routing.profile) ||
      !text(value.routing.context) ||
      !object(value.routing.routes) ||
      !Object.values(value.routing.routes).every(
        (v) =>
          Array.isArray(v) && v.length > 0 && v.every((item) => item !== null && selection(item)),
      ))
  )
    return false;
  if (!value.visits.every((v) => object(v) && text(v.id) && phases.includes(v.phase as Phase)))
    return false;
  const visits = new Set(value.visits.map((v) => (v as { id: string }).id));
  const { assignments, attempts, artifacts } = value;
  const knownArtifact = (id: string) => Object.hasOwn(artifacts, id) || Object.hasOwn(imports, id);
  if (
    !Object.entries(assignments).every(
      ([id, a]) =>
        object(a) &&
        a.id === id &&
        visits.has(String(a.visitId)) &&
        phases.includes(a.phase as Phase) &&
        text(a.role) &&
        strings(a.inputs) &&
        strings(a.attemptIds) &&
        selection(a.selection),
    )
  )
    return false;
  if (
    !Object.values(attempts).every(
      (a) =>
        object(a) &&
        text(a.assignmentId) &&
        Object.hasOwn(assignments, a.assignmentId) &&
        integer(a.startedAt) &&
        integer(a.timeoutMs) &&
        Number(a.timeoutMs) > 0 &&
        (a.outcome === null ||
          ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
            String(a.outcome),
          )) &&
        (a.artifactId === null || (text(a.artifactId) && Object.hasOwn(artifacts, a.artifactId))) &&
        text(a.artifactPath) &&
        selection(a.selection),
    )
  )
    return false;
  if (
    !Object.entries(artifacts).every(
      ([id, a]) =>
        object(a) &&
        a.artifact_id === id &&
        text(a.attemptId) &&
        Object.hasOwn(attempts, a.attemptId) &&
        text(a.kind) &&
        text(a.path) &&
        a.version === 1 &&
        text(a.digest) &&
        strings(a.inputs) &&
        a.inputs.every(knownArtifact),
    )
  )
    return false;
  if (
    !Object.values(assignments).every(
      (a) =>
        object(a) &&
        strings(a.inputs) &&
        a.inputs.every(knownArtifact) &&
        strings(a.attemptIds) &&
        a.attemptIds.every((id) => Object.hasOwn(attempts, id)),
    )
  )
    return false;
  if (
    !Object.entries(value.accepted).every(
      ([phase, id]) => phases.includes(phase as Phase) && text(id) && Object.hasOwn(artifacts, id),
    )
  )
    return false;
  if (value.feedback !== null && (!text(value.feedback) || !knownArtifact(value.feedback)))
    return false;
  return (
    value.human_input === null ||
    (strings(value.human_input) &&
      value.human_input.length === 2 &&
      visits.has(value.human_input[0] ?? "") &&
      Object.hasOwn(artifacts, value.human_input[1] ?? ""))
  );
}

export function migrate(value: LegacyWorkflowState): WorkflowState {
  const { version: _version, ready, human_input, ...data } = structuredClone(value);
  if (ready && human_input)
    throw new WorkflowValidationError("conflicting Pi checkpoint lifecycle");
  const visit = data.visits.at(-1);
  if (!visit) throw new WorkflowValidationError("missing Pi checkpoint visit");
  const plan = data.accepted.plan;
  if (
    ready &&
    (visit.phase !== "plan" ||
      !plan ||
      Object.values(data.attempts).some((a) => a.outcome === null))
  )
    throw new WorkflowValidationError("invalid completed Pi checkpoint");
  if (
    human_input &&
    (human_input[0] !== visit.id || Object.values(data.attempts).some((a) => a.outcome === null))
  )
    throw new WorkflowValidationError("invalid approval checkpoint");
  return {
    ...data,
    version: 3,
    definition: { id: knowledgeDefinition.id, version: knowledgeDefinition.version },
    instanceId: data.run_id,
    imports: {},
    lifecycle: ready
      ? { status: "completed", artifactId: plan as string }
      : human_input
        ? { status: "awaiting_approval", visitId: human_input[0], artifactId: human_input[1] }
        : { status: "active" },
  };
}

export function decodeCheckpoint(value: unknown): WorkflowState | null {
  if (value === null) return null;
  if (validLegacyState(value)) return migrate(value);
  if (
    object(value) &&
    value.version === 2 &&
    object(value.definition) &&
    value.definition.id === knowledgeDefinition.id &&
    [1, knowledgeDefinition.version].includes(Number(value.definition.version)) &&
    typeof value.instanceId === "string" &&
    value.instanceId.trim() &&
    object(value.lifecycle) &&
    ["active", "awaiting_approval", "completed"].includes(String(value.lifecycle.status))
  ) {
    const { lifecycle } = value;
    const legacy = {
      ...value,
      version: 1,
      ready: lifecycle.status === "completed",
      human_input:
        lifecycle.status === "awaiting_approval" ? [lifecycle.visitId, lifecycle.artifactId] : null,
    };
    if (validLegacyState(legacy)) {
      const decoded = migrate(legacy);
      if (lifecycle.status === "completed" && lifecycle.artifactId !== decoded.accepted.plan)
        throw new WorkflowValidationError("invalid completed Pi checkpoint");
      return { ...decoded, instanceId: value.instanceId };
    }
  }
  if (
    object(value) &&
    value.version === 3 &&
    object(value.definition) &&
    value.definition.id === knowledgeDefinition.id &&
    value.definition.version === knowledgeDefinition.version &&
    typeof value.instanceId === "string" &&
    value.instanceId.trim() &&
    object(value.imports) &&
    object(value.lifecycle) &&
    ["active", "awaiting_approval", "completed"].includes(String(value.lifecycle.status))
  ) {
    const imports = value.imports as Record<string, ImportedArtifact>;
    if (
      !Object.entries(imports).every(
        ([id, artifact]) =>
          artifact.artifact_id === id &&
          textValue(artifact.kind) &&
          textValue(artifact.path) &&
          artifact.version === 1 &&
          textValue(artifact.digest),
      )
    )
      throw new WorkflowValidationError("invalid imported knowledge artifact reference");
    const { lifecycle } = value;
    const legacy = {
      ...value,
      version: 1,
      ready: lifecycle.status === "completed",
      human_input:
        lifecycle.status === "awaiting_approval" ? [lifecycle.visitId, lifecycle.artifactId] : null,
    };
    if (validLegacyState(legacy, imports)) {
      const decoded = migrate(legacy);
      if (lifecycle.status === "completed" && lifecycle.artifactId !== decoded.accepted.plan)
        throw new WorkflowValidationError("invalid completed Pi checkpoint");
      return {
        ...decoded,
        instanceId: value.instanceId,
        imports: structuredClone(imports),
      };
    }
  }
  throw new WorkflowValidationError(
    "unsupported Pi checkpoint or workflow definition; preserve the journal and inspect the recorded run",
  );
}
