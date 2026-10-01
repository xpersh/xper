import type {
  ArtifactInput,
  JudgmentEvaluation,
  AttemptOutcome,
  ImplementationCriterion,
  ModelSelection,
  ModelUsage,
  RemainingBudget,
} from "../workflow/types.js";

export type ExecutionResult = {
  outcome: AttemptOutcome;
  brief?: string | undefined;
  reason?: string | undefined;
  usage?: ModelUsage[] | undefined;
};

interface ExecutionBase {
  task: string;
  role: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  model?: string;
  selection?: ModelSelection;
  inputArtifacts?: ArtifactInput[];
  artifactKind?: string;
  budget?: RemainingBudget;
}
export interface KnowledgeExecution extends ExecutionBase {
  workflow: "knowledge";
}
interface DeliveryExecution extends ExecutionBase {
  attemptId: string;
  assignmentId: string;
  incrementId: string;
  baseCommit: string;
  criteria: ImplementationCriterion[];
  verification: string[];
}
export interface ImplementationExecution extends DeliveryExecution {
  reworkReportId?: string;
  workflow: "implementation";
}
export interface VerificationExecution extends DeliveryExecution {
  workflow: "verification";
  evaluatedCommit: string;
  implementationArtifactId: string;
  implementationTestCommands: string[];
}
export interface JudgmentExecution extends ExecutionBase {
  workflow: "judgment";
  assignmentId: string;
  evaluation: JudgmentEvaluation;
}
export type ExecutionRequest =
  | KnowledgeExecution
  | ImplementationExecution
  | VerificationExecution
  | JudgmentExecution;
