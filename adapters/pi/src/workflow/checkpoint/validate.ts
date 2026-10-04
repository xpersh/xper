import { decodeJudgmentHistory, validateJudgmentHistory } from "./judgments.js";
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
  history: unknown = [],
): AdapterCheckpoint {
  const judgmentHistory = decodeJudgmentHistory(history);
  const { implementations, verifications } = decodeHistories(
    knowledge,
    implementationValue,
    verificationValue,
    judgmentHistory,
  );
  validateReconciliations(
    knowledge,
    implementations,
    verifications,
    authorizedPlan,
    reconciliations,
    judgmentHistory,
  );
  validateSerialDelivery(
    implementations,
    verifications,
    authorizedPlan?.artifactId ?? null,
    authorizedPlan?.reworkReportId,
  );
  const checkpoint: AdapterCheckpoint = {
    version: 9,
    judgmentHistory,
    closure: null,
    judgment: decodeJudgment(judgment),
    knowledge,
    implementations,
    verifications,
    authorizedPlan: structuredClone(authorizedPlan),
    reconciliations: structuredClone(reconciliations),
  };
  validateJudgmentHistory(checkpoint);
  validateJudgmentReferences(checkpoint);
  checkpoint.closure = decodeClosure(closure, checkpoint);
  return checkpoint;
}
