import type {
  ArtifactInput,
  AttemptOutcome,
  JudgmentEvaluation,
  ModelSelection,
  WorkflowPosition,
} from "../types.js";
import type { Verdict } from "./contract.js";
import { judgmentDefinition } from "./definition.js";
export interface JudgmentState {
  version: 1;
  revision: number;
  runId: string;
  instanceId: string;
  definition: { id: string; version: number };
  assignmentId: string;
  evaluation: JudgmentEvaluation;
  selection: ModelSelection | null;
  model: string | null;
  attempts: Record<
    string,
    {
      startedAt: number;
      timeoutMs: number;
      outcome: AttemptOutcome | "interrupted" | null;
      artifactPath: string;
    }
  >;
  report: (ArtifactInput & { digest: string; attemptId: string; verdict: Verdict }) | null;
}
export function judgmentPosition(state: JudgmentState): WorkflowPosition {
  return {
    definitionId: judgmentDefinition.id,
    definitionVersion: judgmentDefinition.version,
    instanceId: state.instanceId,
    nodeId: state.report ? "reported" : "judge",
    phase: "judgment_day",
    visitId: state.instanceId,
    status: state.report ? "completed" : "active",
    activeAttemptIds: Object.entries(state.attempts)
      .filter(([, attempt]) => attempt.outcome === null)
      .map(([id]) => id),
    ...(state.report ? { artifactId: state.report.artifact_id } : {}),
  };
}
