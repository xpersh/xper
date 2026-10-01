import type { PlannedAssignment } from "../knowledge/contract.js";
import type {
  ArtifactInput,
  AttemptFinished,
  FinishAttempt,
  ImplementationCriterion,
  ModelSelection,
  RemainingBudget,
  VerificationAssignmentStarted,
} from "../types.js";
import type { VerificationState } from "./state.js";

export interface VerificationEvidence {
  content: string;
  digest: string;
}

export interface VerificationFact {
  type: string;
  data: Record<string, unknown>;
}

export type VerificationEvent =
  | {
      type: "assignment.start";
      runId: string;
      instanceId: string;
      attemptId: string;
      assignmentId?: string;
      planArtifactId: string;
      planDigest: string;
      implementation: VerificationState["implementation"];
      assignment: PlannedAssignment;
      inputs: string[];
      inputArtifacts: ArtifactInput[];
      criteria: ImplementationCriterion[];
      verification: string[];
      selection: ModelSelection | null;
      model: string | null;
      attemptTimeMs: number;
      attemptCostMicros: number;
      assignmentBudget: RemainingBudget;
      globalBudget: RemainingBudget;
    }
  | {
      type: "attempt.finish";
      result: FinishAttempt;
      artifactId: string;
      evidence?: VerificationEvidence;
    }
  | { type: "session.recover" };

export type Results = {
  "assignment.start": VerificationAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "session.recover": undefined;
};

export interface VerificationTransition<Result> {
  state: VerificationState;
  facts: VerificationFact[];
  result: Result;
}

export type FactEmitter = (type: string, data: Record<string, unknown>) => void;
