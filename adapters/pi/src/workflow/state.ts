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

const textValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
export interface ImportedArtifact extends ArtifactInput {
  digest: string;
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
function validLegacyState(
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

export type WorkflowLifecycle =
  | { status: "active" }
  | { status: "awaiting_approval"; visitId: string; artifactId: string }
  | { status: "completed"; artifactId: string };

/** Knowledge instance data. Other workflow kinds own their own context schema. */
export interface WorkflowState
  extends Omit<LegacyWorkflowState, "version" | "ready" | "human_input"> {
  version: 3;
  definition: { id: string; version: number };
  instanceId: string;
  imports: Record<string, ImportedArtifact>;
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

/** Pure migration: callers decide when to save; unsupported data is never reset. */
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

/** Adapter checkpoint envelope composing independent workflow instances for one run. */
export interface DeliveryPlanAuthorization {
  artifactId: string;
  digest: string;
  /** Null for the initial Plan; revised Plans freeze the explicitly selected checkout revision. */
  baseCommit: string | null;
}

export interface DeliveryReconciliation {
  verificationArtifactId: string;
  sourceAttemptId: string;
  incrementId: string;
  reason: "ambiguous_criteria" | "infeasible_design";
  previousPlanArtifactId: string;
  previousPlanDigest: string;
  revisedPlanArtifactId: string | null;
  invalidatedVerificationArtifactIds: string[];
  status: "revisiting" | "awaiting_resume" | "resumed";
  resumeCommit: string | null;
}

export interface AdapterCheckpoint {
  version: 5;
  knowledge: WorkflowState;
  implementations: Record<string, ImplementationState[]>;
  verifications: Record<string, VerificationState[]>;
  authorizedPlan: DeliveryPlanAuthorization | null;
  reconciliations: DeliveryReconciliation[];
}

export function verifiedDeliveryTip(
  implementations: Record<string, ImplementationState[]>,
  verifications: Record<string, VerificationState[]>,
  planArtifactId?: string,
): string | null {
  const verifiedEdges = new Map<string, string>();
  const evaluatedCommits = new Set<string>();
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = planArtifactId
      ? history.findLast((candidate) => candidate.planArtifactId === planArtifactId)
      : history.at(-1);
    if (!implementation) continue;
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === implementation.planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
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
  activePlanArtifactId: string | null,
): void {
  let frontiers = 0;
  for (const [incrementId, history] of Object.entries(implementations)) {
    const implementation = activePlanArtifactId
      ? history.findLast((candidate) => candidate.planArtifactId === activePlanArtifactId)
      : undefined;
    if (!implementation) continue;
    const verification = (verifications[incrementId] ?? []).findLast(
      (candidate) =>
        candidate.planArtifactId === implementation.planArtifactId &&
        candidate.implementation.instanceId === implementation.instanceId,
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
  const plans = new Set(
    Object.values(implementations)
      .flat()
      .map((implementation) => implementation.planArtifactId),
  );
  for (const plan of plans) verifiedDeliveryTip(implementations, verifications, plan);
}

const commit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);

function decodeEnvelope(
  knowledge: WorkflowState,
  implementationValue: Record<string, unknown>,
  verificationValue: Record<string, unknown>,
  authorizedPlan: DeliveryPlanAuthorization | null,
  reconciliations: DeliveryReconciliation[],
): AdapterCheckpoint {
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
  for (const [incrementId, history] of Object.entries(implementations)) {
    const reviews = verifications[incrementId] ?? [];
    for (const planArtifactId of new Set(history.map((entry) => entry.planArtifactId))) {
      const planHistory = history.filter((entry) => entry.planArtifactId === planArtifactId);
      const planReviews = reviews.filter((entry) => entry.planArtifactId === planArtifactId);
      if (planReviews.length > planHistory.length)
        throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (const [index, review] of planReviews.entries())
        if (review.implementation.instanceId !== planHistory[index]?.instanceId)
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      for (let index = 1; index < planHistory.length; index++) {
        const previousImplementation = planHistory[index - 1];
        const previousVerification = planReviews[index - 1];
        const rework = planHistory[index];
        if (
          previousImplementation?.lifecycle.status !== "completed" ||
          previousVerification?.lifecycle.status !== "completed" ||
          previousVerification.lifecycle.verdict !== "rejected" ||
          previousVerification.artifacts[previousVerification.lifecycle.artifactId]
            ?.knowledgeFeedbackReason !== undefined ||
          !rework ||
          rework.baseCommit !== previousVerification.implementation.evaluatedCommit ||
          !rework.assignment.inputs.includes(previousImplementation.lifecycle.artifactId) ||
          !rework.assignment.inputs.includes(previousVerification.lifecycle.artifactId)
        )
          throw new WorkflowValidationError("invalid delivery checkpoint history order");
      }
    }
  }
  for (const history of [...Object.values(implementations), ...Object.values(verifications)])
    for (const instance of history)
      if (instance.assignment.inputs.some((id) => !artifactIds.has(id)))
        throw new WorkflowValidationError("invalid delivery checkpoint artifact reference");
  for (const [id, imported] of Object.entries(knowledge.imports)) {
    const owner = Object.values(verifications)
      .flat()
      .map((state) => state.artifacts[id])
      .find(Boolean);
    if (
      !owner ||
      owner.artifact_id !== imported.artifact_id ||
      owner.kind !== imported.kind ||
      owner.path !== imported.path ||
      owner.version !== imported.version ||
      owner.digest !== imported.digest
    )
      throw new WorkflowValidationError("invalid imported knowledge artifact reference");
  }
  if (authorizedPlan) {
    const plan = knowledge.artifacts[authorizedPlan.artifactId];
    if (
      !plan ||
      plan.digest !== authorizedPlan.digest ||
      (authorizedPlan.baseCommit !== null && !commit(authorizedPlan.baseCommit))
    )
      throw new WorkflowValidationError("invalid authorized delivery Plan");
  } else if (Object.keys(implementations).length || Object.keys(verifications).length) {
    throw new WorkflowValidationError("delivery history has no authorized Plan");
  }
  const seenFeedback = new Set<string>();
  for (const [index, reconciliation] of reconciliations.entries()) {
    const verification = Object.values(verifications)
      .flat()
      .find((state) => Object.hasOwn(state.artifacts, reconciliation.verificationArtifactId));
    const artifact = verification?.artifacts[reconciliation.verificationArtifactId];
    const imported = knowledge.imports[reconciliation.verificationArtifactId];
    const previousPlan = knowledge.artifacts[reconciliation.previousPlanArtifactId];
    const preceding = reconciliations[index - 1];
    const expectedInvalidated = Object.values(verifications)
      .flat()
      .filter(
        (state) =>
          state.planArtifactId === reconciliation.previousPlanArtifactId &&
          state.lifecycle.status === "completed" &&
          state.lifecycle.verdict === "verified",
      )
      .map((state) => (state.lifecycle.status === "completed" ? state.lifecycle.artifactId : ""));
    const invalidated = new Set(reconciliation.invalidatedVerificationArtifactIds);
    if (
      seenFeedback.has(reconciliation.verificationArtifactId) ||
      !verification ||
      !artifact ||
      !imported ||
      imported.artifact_id !== artifact.artifact_id ||
      imported.kind !== artifact.kind ||
      imported.path !== artifact.path ||
      imported.version !== artifact.version ||
      imported.digest !== artifact.digest ||
      artifact.knowledgeFeedbackReason !== reconciliation.reason ||
      artifact.attemptId !== reconciliation.sourceAttemptId ||
      verification.incrementId !== reconciliation.incrementId ||
      verification.planArtifactId !== reconciliation.previousPlanArtifactId ||
      verification.planDigest !== reconciliation.previousPlanDigest ||
      !previousPlan ||
      previousPlan.digest !== reconciliation.previousPlanDigest ||
      !["revisiting", "awaiting_resume", "resumed"].includes(reconciliation.status) ||
      (reconciliation.revisedPlanArtifactId !== null &&
        !knowledge.artifacts[reconciliation.revisedPlanArtifactId]) ||
      !Array.isArray(reconciliation.invalidatedVerificationArtifactIds) ||
      invalidated.size !== reconciliation.invalidatedVerificationArtifactIds.length ||
      (reconciliation.status === "revisiting"
        ? invalidated.size !== 0
        : invalidated.size !== expectedInvalidated.length ||
          expectedInvalidated.some((id) => !invalidated.has(id))) ||
      (reconciliation.resumeCommit !== null && !commit(reconciliation.resumeCommit)) ||
      (reconciliation.status === "revisiting" &&
        (reconciliation.revisedPlanArtifactId !== null || reconciliation.resumeCommit !== null)) ||
      (reconciliation.status === "awaiting_resume" &&
        (reconciliation.revisedPlanArtifactId === null || reconciliation.resumeCommit !== null)) ||
      (reconciliation.status === "resumed" &&
        (reconciliation.revisedPlanArtifactId === null || reconciliation.resumeCommit === null)) ||
      (preceding &&
        (preceding.status !== "resumed" ||
          preceding.revisedPlanArtifactId !== reconciliation.previousPlanArtifactId)) ||
      (index < reconciliations.length - 1 && reconciliation.status !== "resumed")
    )
      throw new WorkflowValidationError("invalid delivery reconciliation");
    seenFeedback.add(reconciliation.verificationArtifactId);
  }
  if (Object.keys(knowledge.imports).some((id) => !seenFeedback.has(id)))
    throw new WorkflowValidationError("invalid imported knowledge artifact reference");
  const currentReconciliation = reconciliations.at(-1);
  const expectedAuthorizedPlan = currentReconciliation
    ? currentReconciliation.status === "resumed"
      ? currentReconciliation.revisedPlanArtifactId
      : currentReconciliation.previousPlanArtifactId
    : knowledge.lifecycle.status === "completed"
      ? knowledge.lifecycle.artifactId
      : null;
  if ((authorizedPlan?.artifactId ?? null) !== expectedAuthorizedPlan)
    throw new WorkflowValidationError("invalid authorized delivery Plan");
  if (
    currentReconciliation?.status !== "revisiting" &&
    currentReconciliation &&
    (knowledge.lifecycle.status !== "completed" ||
      knowledge.lifecycle.artifactId !== currentReconciliation.revisedPlanArtifactId)
  )
    throw new WorkflowValidationError("invalid delivery reconciliation");
  validateSerialDelivery(implementations, verifications, authorizedPlan?.artifactId ?? null);
  return {
    version: 5,
    knowledge,
    implementations,
    verifications,
    authorizedPlan: structuredClone(authorizedPlan),
    reconciliations: structuredClone(reconciliations),
  };
}

/** Migrate legacy checkpoints without rewriting them on read. */
export function decodeAdapterCheckpoint(value: unknown): AdapterCheckpoint | null {
  if (value === null) return null;
  if (object(value) && (value.version === 4 || value.version === 5)) {
    const knowledge = decodeCheckpoint(value.knowledge);
    if (!knowledge || !object(value.implementations) || !object(value.verifications))
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    if (value.version === 4) {
      const planId = knowledge.accepted.plan;
      const plan = planId ? knowledge.artifacts[planId] : undefined;
      return decodeEnvelope(
        knowledge,
        value.implementations,
        value.verifications,
        planId && plan ? { artifactId: planId, digest: plan.digest, baseCommit: null } : null,
        [],
      );
    }
    if (
      !(value.authorizedPlan === null || object(value.authorizedPlan)) ||
      !Array.isArray(value.reconciliations)
    )
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    const authorizedPlan = value.authorizedPlan as DeliveryPlanAuthorization | null;
    if (
      authorizedPlan !== null &&
      (!textValue(authorizedPlan.artifactId) ||
        !textValue(authorizedPlan.digest) ||
        !(authorizedPlan.baseCommit === null || commit(authorizedPlan.baseCommit)))
    )
      throw new WorkflowValidationError("invalid authorized delivery Plan");
    return decodeEnvelope(
      knowledge,
      value.implementations,
      value.verifications,
      authorizedPlan,
      value.reconciliations as DeliveryReconciliation[],
    );
  }
  if (object(value) && value.version === 3 && Object.hasOwn(value, "knowledge")) {
    const knowledge = decodeCheckpoint(value.knowledge);
    if (!knowledge || !object(value.implementations))
      throw new WorkflowValidationError("invalid Pi adapter checkpoint envelope");
    const histories = Object.fromEntries(
      Object.entries(value.implementations).map(([incrementId, implementation]) => [
        incrementId,
        [implementation],
      ]),
    );
    const planId = knowledge.accepted.plan;
    const plan = planId ? knowledge.artifacts[planId] : undefined;
    return decodeEnvelope(
      knowledge,
      histories,
      {},
      planId && plan ? { artifactId: planId, digest: plan.digest, baseCommit: null } : null,
      [],
    );
  }
  const knowledge = decodeCheckpoint(value);
  if (!knowledge) return null;
  const planId = knowledge.accepted.plan;
  const plan = planId ? knowledge.artifacts[planId] : undefined;
  return decodeEnvelope(
    knowledge,
    {},
    {},
    planId && plan ? { artifactId: planId, digest: plan.digest, baseCommit: null } : null,
    [],
  );
}
