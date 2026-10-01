import type { ModelSelection } from "../../bridge/xper-client.js";
import type { PlannedAssignment } from "../knowledge/contract.js";
import type {
  ArtifactInput,
  AttemptFinished,
  FinishAttempt,
  ImplementationAssignmentStarted,
  ImplementationCriterion,
  RemainingBudget,
} from "../types.js";
import type { ImplementationState } from "./state.js";

export interface ImplementationFact {
  type: string;
  data: Record<string, unknown>;
}

export interface ImplementationEvidence {
  content: string;
  digest: string;
}

export type ImplementationEvent =
  | {
      type: "assignment.start";
      runId: string;
      instanceId: string;
      attemptId: string;
      assignmentId?: string;
      planArtifactId: string;
      planDigest: string;
      assignment: PlannedAssignment;
      inputs: string[];
      inputArtifacts: ArtifactInput[];
      criteria: ImplementationCriterion[];
      verification: string[];
      selection: ModelSelection | null;
      model: string | null;
      baseCommit: string;
      reworkReportId?: string;
      attemptTimeMs: number;
      attemptCostMicros: number;
      assignmentBudget?: RemainingBudget;
      globalBudget: RemainingBudget;
    }
  | {
      type: "attempt.finish";
      result: FinishAttempt;
      artifactId: string;
      evidence?: ImplementationEvidence;
    }
  | { type: "session.recover" };

export type ImplementationResultByEvent = {
  "assignment.start": ImplementationAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "session.recover": undefined;
};

export interface ImplementationTransition<Result> {
  state: ImplementationState;
  facts: ImplementationFact[];
  result: Result;
}

export type FactEmitter = (type: string, data: Record<string, unknown>) => void;
