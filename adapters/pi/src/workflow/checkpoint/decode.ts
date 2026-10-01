import { decodeCheckpoint, textValue } from "../knowledge/checkpoint.js";
import { WorkflowValidationError } from "../types.js";
import { commit, object } from "../validation.js";
import type {
  AdapterCheckpoint,
  DeliveryPlanAuthorization,
  DeliveryReconciliation,
} from "./types.js";
import { decodeEnvelope } from "./validate.js";

export function decodeAdapterCheckpoint(value: unknown): AdapterCheckpoint | null {
  if (value === null) return null;
  if (object(value) && (value.version === 4 || value.version === 5 || value.version === 6)) {
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
      !Array.isArray(value.reconciliations) ||
      (value.version === 6 && !Object.hasOwn(value, "judgment"))
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
      value.version === 6 ? value.judgment : null,
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
