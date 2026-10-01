import { decodeJudgment } from "../judgment/checkpoint.js";
import { validateJudgmentReferences } from "../delivery/judgment.js";
import { decodeClosure } from "./closure.js";
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
  judgment: unknown = null,
  closure: unknown = null,
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
  const checkpoint: AdapterCheckpoint = {
    version: 7,
    closure: null,
    judgment: decodeJudgment(judgment),
    knowledge,
    implementations,
    verifications,
    authorizedPlan: structuredClone(authorizedPlan),
    reconciliations: structuredClone(reconciliations),
  };
  validateJudgmentReferences(checkpoint);
  checkpoint.closure = decodeClosure(closure, checkpoint);
  return checkpoint;
}
