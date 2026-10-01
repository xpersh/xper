import { validateSerialDelivery } from "../delivery/history.js";
import type { WorkflowState } from "../knowledge/state.js";
import { decodeHistories } from "./histories.js";
import { validateReconciliations } from "./reconciliation.js";
import type {
  AdapterCheckpoint,
  DeliveryPlanAuthorization,
  DeliveryReconciliation,
} from "./types.js";
export function decodeEnvelope(
  knowledge: WorkflowState,
  implementationValue: Record<string, unknown>,
  verificationValue: Record<string, unknown>,
  authorizedPlan: DeliveryPlanAuthorization | null,
  reconciliations: DeliveryReconciliation[],
): AdapterCheckpoint {
  const { implementations, verifications } = decodeHistories(
    knowledge,
    implementationValue,
    verificationValue,
  );
  validateReconciliations(
    knowledge,
    implementations,
    verifications,
    authorizedPlan,
    reconciliations,
  );
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
