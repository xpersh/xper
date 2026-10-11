import type { ResolvedConfiguration } from "../../bridge/xper-client.js";
import type {
  AttemptFinished,
  FinishAttempt,
  KnowledgeAssignmentStarted,
  ModelUsage,
  RunAdvanced,
  RunStarted,
  WorkflowPolicy,
} from "../types.js";
import type { ImportedArtifact, WorkflowState } from "./state.js";

export interface WorkflowFact {
  type: string;
  data: Record<string, unknown>;
}

export interface Evidence {
  content: string;
  digest: string;
}

export type GateEvidence = { artifacts: Record<string, Evidence> } | { error: string };

export type KnowledgeEvent =
  | {
      type: "run.start";
      runId: string;
      instanceId: string;
      visitId: string;
      objectiveHash: string;
      configuration: ResolvedConfiguration;
      policy?: WorkflowPolicy;
    }
  | { type: "assignment.start"; assignmentId?: string; newAssignmentId: string; attemptId: string }
  | { type: "attempt.finish"; result: FinishAttempt; artifactId: string; evidence?: Evidence }
  | {
      type: "gate.evaluate";
      approvedArtifactId?: string;
      nextVisitId: string;
      evidence: GateEvidence;
    }
  | {
      type: "delivery.feedback";
      nextVisitId: string;
      sourceAttemptId: string;
      incrementId?: string;
      incrementIds?: string[];
      planArtifactId: string;
      planDigest: string;
      reason: "ambiguous_criteria" | "infeasible_design";
      evidence: string;
      paths: string[];
      artifact: ImportedArtifact;
      resolution?: ImportedArtifact;
    }
  | { type: "session.recover" }
  | { type: "usage.record"; attemptId: string; usage: ModelUsage };

export interface Results {
  "run.start": RunStarted;
  "assignment.start": KnowledgeAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "gate.evaluate": RunAdvanced;
  "delivery.feedback": RunAdvanced;
  "session.recover": undefined;
  "usage.record": undefined;
}

export interface Transition<Result> {
  state: WorkflowState;
  facts: WorkflowFact[];
  result: Result;
}

export type FactEmitter = (type: string, data: Record<string, unknown>) => void;
