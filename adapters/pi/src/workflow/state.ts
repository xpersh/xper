import { object } from "../bridge/xper-client.js";
import type {
  ArtifactInput,
  FinishAttempt,
  ModelSelection,
  RoutingSnapshot,
  RunSummary,
} from "./types.js";
import { WorkflowValidationError } from "./types.js";
import { phases, policyFrom, type Phase, type Policy } from "./policy.js";
import { knowledgeDefinition } from "./definition.js";
import { decodeImplementationState, type ImplementationState } from "./implementation.js";

export interface Assignment {
  id: string;
  visitId: string;
  phase: Phase;
  role: string;
  inputs: string[];
  selection: ModelSelection | null;
  attemptIds: string[];
}
export interface Attempt {
  assignmentId: string;
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
}
export interface Artifact extends ArtifactInput {
  attemptId: string;
  digest: string;
  inputs: string[];
}
interface LegacyWorkflowState {
  version: 1;
  revision: number;
  run_id: string;
  startedAt: number;
  routing: RoutingSnapshot | null;
  policy: Policy;
  visits: Array<{ id: string; phase: Phase }>;
  assignments: Record<string, Assignment>;
  attempts: Record<string, Attempt>;
  artifacts: Record<string, Artifact>;
  accepted: Partial<Record<Phase, string>>;
  feedback: string | null;
  human_input: [string, string] | null;
  ready: boolean;
}
function validLegacyState(value: unknown): value is LegacyWorkflowState {
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
        a.inputs.every((input) => Object.hasOwn(artifacts, input)),
    )
  )
    return false;
  if (
    !Object.values(assignments).every(
      (a) =>
        object(a) &&
        strings(a.inputs) &&
        a.inputs.every((id) => Object.hasOwn(artifacts, id)) &&
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
  if (
    value.feedback !== null &&
    (!text(value.feedback) || !Object.hasOwn(artifacts, value.feedback))
  )
    return false;
  return (
    value.human_input === null ||
    (strings(value.human_input) &&
      value.human_input.length === 2 &&
      visits.has(value.human_input[0] ?? "") &&
      Object.hasOwn(artifacts, value.human_input[1] ?? ""))
  );
}

export type WorkflowLifecycle =
  | { status: "active" }
  | { status: "awaiting_approval"; visitId: string; artifactId: string }
  | { status: "completed"; artifactId: string };

/** Knowledge instance data. Other workflow kinds own their own context schema. */
export interface WorkflowState
  extends Omit<LegacyWorkflowState, "version" | "ready" | "human_input"> {
  version: 2;
  definition: { id: string; version: number };
  instanceId: string;
  lifecycle: WorkflowLifecycle;
}

export function currentVisit(state: WorkflowState): { id: string; phase: Phase } {
  const visit = state.visits.at(-1);
  if (!visit) throw new WorkflowValidationError("no active knowledge phase");
  return visit;
}

/** Legacy UI fields are projections, never an additional mutable state machine. */
export function toRunSummary(state: WorkflowState): RunSummary &
  WorkflowState & {
    ready: boolean;
    human_input: [string, string] | null;
  } {
  return {
    ...structuredClone(state),
    ready: state.lifecycle.status === "completed",
    human_input:
      state.lifecycle.status === "awaiting_approval"
        ? [state.lifecycle.visitId, state.lifecycle.artifactId]
        : null,
  };
}

function migrate(value: LegacyWorkflowState): WorkflowState {
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
    version: 2,
    definition: { id: knowledgeDefinition.id, version: knowledgeDefinition.version },
    instanceId: data.run_id,
    lifecycle: ready
      ? { status: "completed", artifactId: plan as string }
      : human_input
        ? { status: "awaiting_approval", visitId: human_input[0], artifactId: human_input[1] }
        : { status: "active" },
  };
}

/** Pure migration: callers decide when to save; unsupported data is never reset. */
export function decodeCheckpoint(value: unknown): WorkflowState | null {
  if (value === null) return null;
  if (validLegacyState(value)) return migrate(value);
  if (
    object(value) &&
    value.version === 2 &&
    object(value.definition) &&
    value.definition.id === knowledgeDefinition.id &&
    value.definition.version === knowledgeDefinition.version &&
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
  throw new WorkflowValidationError(
    "unsupported Pi checkpoint or workflow definition; preserve the journal and inspect the recorded run",
  );
}

/** Adapter checkpoint envelope composing independent workflow instances for one run. */
export interface AdapterCheckpoint {
  version: 3;
  knowledge: WorkflowState;
  implementations: Record<string, ImplementationState>;
}

/** Migrate legacy knowledge-only checkpoints without rewriting them on read. */
export function decodeAdapterCheckpoint(value: unknown): AdapterCheckpoint | null {
  if (value === null) return null;
  if (object(value) && value.version === 3) {
    const knowledge = decodeCheckpoint(value.knowledge);
    if (!knowledge || !object(value.implementations))
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    const implementations: Record<string, ImplementationState> = {};
    for (const [incrementId, implementation] of Object.entries(value.implementations)) {
      const decoded = decodeImplementationState(implementation);
      const plan = knowledge.artifacts[decoded.planArtifactId];
      if (
        decoded.incrementId !== incrementId ||
        decoded.runId !== knowledge.run_id ||
        knowledge.accepted.plan !== decoded.planArtifactId ||
        !plan ||
        plan.digest !== decoded.planDigest ||
        decoded.assignment.inputs.some((id) => !Object.hasOwn(knowledge.artifacts, id)) ||
        implementations[incrementId]
      )
        throw new WorkflowValidationError("invalid implementation checkpoint identity");
      implementations[incrementId] = decoded;
    }
    return { version: 3, knowledge, implementations };
  }
  const knowledge = decodeCheckpoint(value);
  return knowledge ? { version: 3, knowledge, implementations: {} } : null;
}
