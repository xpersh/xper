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
import { decodeVerificationState, type VerificationState } from "./verification.js";

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
  version: 4;
  knowledge: WorkflowState;
  implementations: Record<string, ImplementationState[]>;
  verifications: Record<string, VerificationState[]>;
}

export function verifiedDeliveryTip(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
): string | null {
  const verifiedEdges = new Map<string, string>();
  const evaluatedCommits = new Set<string>();
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = history.at(-1);
    if (!implementation) throw new WorkflowValidationError("invalid implementation history");
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) => candidate.implementation.instanceId === implementation.instanceId,
    );
    if (verification?.lifecycle.status !== "completed") continue;
    if (verification.lifecycle.verdict !== "verified") continue;
    const { baseCommit, evaluatedCommit } = verification.implementation;
    if (verifiedEdges.has(baseCommit) || evaluatedCommits.has(evaluatedCommit))
      throw new WorkflowValidationError("invalid sequential delivery checkpoint");
    verifiedEdges.set(baseCommit, evaluatedCommit);
    evaluatedCommits.add(evaluatedCommit);
  }
  if (!verifiedEdges.size) return null;
  const roots = [...verifiedEdges.keys()].filter((commit) => !evaluatedCommits.has(commit));
  if (roots.length !== 1)
    throw new WorkflowValidationError("invalid sequential delivery checkpoint");
  let commit = roots[0] as string;
  const visited = new Set<string>();
  while (verifiedEdges.has(commit)) {
    if (visited.has(commit))
      throw new WorkflowValidationError("invalid sequential delivery checkpoint");
    visited.add(commit);
    commit = verifiedEdges.get(commit) as string;
  }
  if (visited.size !== verifiedEdges.size)
    throw new WorkflowValidationError("invalid sequential delivery checkpoint");
  return commit;
}

function validateSerialDelivery(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
): void {
  let frontiers = 0;
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = history.at(-1);
    if (!implementation) throw new WorkflowValidationError("invalid implementation history");
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) => candidate.implementation.instanceId === implementation.instanceId,
    );
    if (
      implementation.lifecycle.status === "active" ||
      !verification ||
      verification.lifecycle.status === "active" ||
      verification.lifecycle.verdict === "rejected"
    )
      frontiers++;
  }
  if (frontiers > 1) throw new WorkflowValidationError("invalid overlapping delivery checkpoint");
  verifiedDeliveryTip(implementations, verifications);
}

/** Migrate legacy knowledge-only checkpoints without rewriting them on read. */
export function decodeAdapterCheckpoint(value: unknown): AdapterCheckpoint | null {
  if (value === null) return null;
  if (object(value) && value.version === 4) {
    const knowledge = decodeCheckpoint(value.knowledge);
    if (!knowledge || !object(value.implementations) || !object(value.verifications))
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    const implementations: Record<string, ImplementationState[]> = {};
    const verifications: Record<string, VerificationState[]> = {};
    const instanceIds = new Set<string>([knowledge.instanceId]);
    const attemptIds = new Set(Object.keys(knowledge.attempts));
    const artifactIds = new Set(Object.keys(knowledge.artifacts));
    for (const [incrementId, history] of Object.entries(value.implementations)) {
      if (!Array.isArray(history) || !history.length)
        throw new WorkflowValidationError("invalid implementation checkpoint history");
      implementations[incrementId] = history.map((entry) => {
        const decoded = decodeImplementationState(entry);
        const plan = knowledge.artifacts[decoded.planArtifactId];
        if (
          decoded.incrementId !== incrementId ||
          decoded.runId !== knowledge.run_id ||
          knowledge.accepted.plan !== decoded.planArtifactId ||
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
    for (const [incrementId, history] of Object.entries(value.verifications)) {
      if (!Array.isArray(history) || !history.length)
        throw new WorkflowValidationError("invalid verification checkpoint history");
      verifications[incrementId] = history.map((entry) => {
        const decoded = decodeVerificationState(entry);
        const plan = knowledge.artifacts[decoded.planArtifactId];
        const implementation = implementations[incrementId]?.find(
          (candidate) => candidate.instanceId === decoded.implementation.instanceId,
        );
        const artifact = implementation?.artifacts[decoded.implementation.artifactId];
        if (
          decoded.incrementId !== incrementId ||
          decoded.runId !== knowledge.run_id ||
          knowledge.accepted.plan !== decoded.planArtifactId ||
          !plan ||
          plan.digest !== decoded.planDigest ||
          !implementation ||
          implementation.lifecycle.status !== "completed" ||
          implementation.lifecycle.artifactId !== decoded.implementation.artifactId ||
          !artifact ||
          artifact.digest !== decoded.implementation.digest ||
          decoded.implementation.baseCommit !== implementations[incrementId]?.[0]?.baseCommit ||
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
    for (const [incrementId, history] of Object.entries(implementations)) {
      const reviews = verifications[incrementId] ?? [];
      if (reviews.length > history.length)
        throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (const [index, review] of reviews.entries())
        if (review.implementation.instanceId !== history[index]?.instanceId)
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (let index = 1; index < history.length; index++) {
        const previousImplementation = history[index - 1];
        const previousVerification = reviews[index - 1];
        const rework = history[index];
        if (
          previousImplementation?.lifecycle.status !== "completed" ||
          previousVerification?.lifecycle.status !== "completed" ||
          previousVerification.lifecycle.verdict !== "rejected" ||
          !rework ||
          rework.baseCommit !== previousVerification.implementation.evaluatedCommit ||
          !rework.assignment.inputs.includes(previousImplementation.lifecycle.artifactId) ||
          !rework.assignment.inputs.includes(previousVerification.lifecycle.artifactId)
        )
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      }
    }
    for (const history of [...Object.values(implementations), ...Object.values(verifications)])
      for (const instance of history)
        if (instance.assignment.inputs.some((id) => !artifactIds.has(id)))
          throw new WorkflowValidationError("invalid delivery checkpoint artifact reference");
    validateSerialDelivery(implementations, verifications);
    return { version: 4, knowledge, implementations, verifications };
  }
  if (object(value) && value.version === 3) {
    const knowledge = decodeCheckpoint(value.knowledge);
    if (!knowledge || !object(value.implementations))
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    const implementations: Record<string, ImplementationState[]> = {};
    const instanceIds = new Set<string>([knowledge.instanceId]);
    const attemptIds = new Set(Object.keys(knowledge.attempts));
    const artifactIds = new Set(Object.keys(knowledge.artifacts));
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
        instanceIds.has(decoded.instanceId) ||
        Object.keys(decoded.attempts).some((id) => attemptIds.has(id)) ||
        Object.keys(decoded.artifacts).some((id) => artifactIds.has(id)) ||
        implementations[incrementId]
      )
        throw new WorkflowValidationError("invalid implementation checkpoint identity");
      instanceIds.add(decoded.instanceId);
      for (const id of Object.keys(decoded.attempts)) attemptIds.add(id);
      for (const id of Object.keys(decoded.artifacts)) artifactIds.add(id);
      implementations[incrementId] = [decoded];
    }
    return { version: 4, knowledge, implementations, verifications: {} };
  }
  const knowledge = decodeCheckpoint(value);
  return knowledge ? { version: 4, knowledge, implementations: {}, verifications: {} } : null;
}
