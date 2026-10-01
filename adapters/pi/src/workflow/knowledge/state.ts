import type { Phase, Policy } from "../policy.js";
import type {
  ArtifactInput,
  FinishAttempt,
  ModelSelection,
  RoutingSnapshot,
  RunSummary,
} from "../types.js";
import { WorkflowValidationError } from "../types.js";

export interface Assignment {
  id: string;
  visitId: string;
  phase: Phase;
  role: string;
  inputs: string[];
  selection: ModelSelection | null;
  attemptIds: string[];
}

export interface Attempt {
  assignmentId: string;
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
}

export interface Artifact extends ArtifactInput {
  attemptId: string;
  digest: string;
  inputs: string[];
}

export interface ImportedArtifact extends ArtifactInput {
  digest: string;
}

export interface LegacyWorkflowState {
  version: 1;
  revision: number;
  run_id: string;
  startedAt: number;
  routing: RoutingSnapshot | null;
  policy: Policy;
  visits: Array<{ id: string; phase: Phase }>;
  assignments: Record<string, Assignment>;
  attempts: Record<string, Attempt>;
  artifacts: Record<string, Artifact>;
  accepted: Partial<Record<Phase, string>>;
  feedback: string | null;
  human_input: [string, string] | null;
  ready: boolean;
}

export type WorkflowLifecycle =
  | { status: "active" }
  | { status: "awaiting_approval"; visitId: string; artifactId: string }
  | { status: "completed"; artifactId: string };

export interface WorkflowState
  extends Omit<LegacyWorkflowState, "version" | "ready" | "human_input"> {
  version: 3;
  definition: { id: string; version: number };
  instanceId: string;
  imports: Record<string, ImportedArtifact>;
  lifecycle: WorkflowLifecycle;
}

export function currentVisit(state: WorkflowState): { id: string; phase: Phase } {
  const visit = state.visits.at(-1);
  if (!visit) throw new WorkflowValidationError("no active knowledge phase");
  return visit;
}

export function toRunSummary(state: WorkflowState): RunSummary &
  WorkflowState & {
    ready: boolean;
    human_input: [string, string] | null;
  } {
  return {
    ...structuredClone(state),
    ready: state.lifecycle.status === "completed",
    human_input:
      state.lifecycle.status === "awaiting_approval"
        ? [state.lifecycle.visitId, state.lifecycle.artifactId]
        : null,
  };
}
