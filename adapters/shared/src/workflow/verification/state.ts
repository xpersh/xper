import type { PlannedAssignment } from "../knowledge/contract.js";
import type { FinishAttempt, ImplementationCriterion, ModelSelection } from "../types.js";
import type { KnowledgeFeedbackReason } from "./contract.js";

export interface VerificationAttempt {
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
  model: string | null;
}

export interface VerificationArtifact {
  artifact_id: string;
  attemptId: string;
  kind: "verification_result";
  path: string;
  version: 1;
  digest: string;
  inputs: string[];
  verdict: "verified" | "rejected";
  evaluatedCommit: string;
  knowledgeFeedbackReason?: KnowledgeFeedbackReason;
}

export interface VerificationState {
  version: 1;
  revision: number;
  runId: string;
  definition: { id: string; version: number };
  instanceId: string;
  incrementId: string;
  planArtifactId: string;
  planDigest: string;
  startedAt: number;
  implementation: {
    instanceId: string;
    artifactId: string;
    digest: string;
    baseCommit: string;
    evaluatedCommit: string;
    testCommands: string[];
  };
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
  attempts: Record<string, VerificationAttempt>;
  artifacts: Record<string, VerificationArtifact>;
  lifecycle:
    | { status: "active" }
    | { status: "completed"; artifactId: string; verdict: "verified" | "rejected" };
}
