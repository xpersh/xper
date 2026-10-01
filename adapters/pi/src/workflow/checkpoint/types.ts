import type { JudgmentState } from "../judgment/state.js";
import type { ImplementationState } from "../implementation/state.js";
import type { WorkflowState } from "../knowledge/state.js";
import type { VerificationState } from "../verification/state.js";
import type { JudgmentReopened, RunClosure } from "../types.js";

export interface DeliveryPlanAuthorization {
  artifactId: string;
  digest: string;
  /** Null for the initial Plan; revised Plans freeze the explicitly selected checkout revision. */
  baseCommit: string | null;
  reworkReportId?: string;
}

export interface DeliveryReconciliation {
  verificationArtifactId?: string;
  judgmentArtifactId?: string;
  incrementIds?: string[];
  sourceAttemptId: string;
  incrementId?: string;
  reason: "ambiguous_criteria" | "infeasible_design";
  previousPlanArtifactId: string;
  previousPlanDigest: string;
  revisedPlanArtifactId: string | null;
  invalidatedVerificationArtifactIds: string[];
  status: "revisiting" | "awaiting_resume" | "resumed";
  resumeCommit: string | null;
}

export interface AdapterCheckpoint {
  version: 8;
  judgmentHistory: Array<{
    state: JudgmentState;
    decision: JudgmentReopened;
    authorization: DeliveryPlanAuthorization;
    accepted: WorkflowState["accepted"];
  }>;
  closure: RunClosure | null;
  judgment: JudgmentState | null;
  knowledge: WorkflowState;
  implementations: Record<string, ImplementationState[]>;
  verifications: Record<string, VerificationState[]>;
  authorizedPlan: DeliveryPlanAuthorization | null;
  reconciliations: DeliveryReconciliation[];
}
