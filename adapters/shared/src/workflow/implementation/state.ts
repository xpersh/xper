import type { ModelSelection } from "../../bridge/xper-client.js";
import type { PlannedAssignment } from "../knowledge/contract.js";
import type { FinishAttempt, ImplementationCriterion } from "../types.js";

export interface ImplementationAttempt {
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
  model: string | null;
}

export interface ImplementationArtifact {
  artifact_id: string;
  attemptId: string;
  kind: "implementation_result";
  path: string;
  version: 1;
  digest: string;
  inputs: string[];
  /** Added in checkpoint format 4; older format-3 instances omit it. */
  resultingCommit?: string;
}

export interface ImplementationState {
  version: 1;
  revision: number;
  runId: string;
  definition: { id: string; version: number };
  instanceId: string;
  incrementId: string;
  planArtifactId: string;
  planDigest: string;
  startedAt: number;
  baseCommit: string;
  reworkReportId?: string;
  assignment: PlannedAssignment & {
    inputs: string[];
    criteria: ImplementationCriterion[];
    verification: string[];
    selection: ModelSelection | null;
    model: string | null;
    attemptIds: string[];
  };
  attemptTimeMs: number;
  attemptCostMicros: number;
  attempts: Record<string, ImplementationAttempt>;
  artifacts: Record<string, ImplementationArtifact>;
  lifecycle: { status: "active" } | { status: "completed"; artifactId: string };
}
