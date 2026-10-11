/** Scaffold metadata for the Pi adapter package. */
export const adapterPackage = {
  harness: "pi",
  packageName: "@xper/adapter-pi",
  protocolBoundary: "public",
} as const;

export { BridgeClient, connectBridge } from "@xper/adapter-shared/bridge";
export { XperClient } from "@xper/adapter-shared/bridge";
export type {
  WorkflowClient,
  WorkflowPosition,
  RunStarted,
  AssignmentStarted,
  KnowledgeAssignmentStarted,
  ImplementationAssignmentStarted,
  VerificationAssignmentStarted,
  StartedAssignment,
  ImplementationCriterion,
  FinishAttempt,
  AttemptFinished,
  AttemptOutcome,
  RunAdvanced,
  RunSummary,
  RunStatus,
  RunClosure,
  JudgmentApplied,
  JudgmentApproval,
  JudgmentDebt,
  JudgmentDecision,
  JudgmentResolution,
  JudgmentResolutionInput,
  JudgmentReopened,
} from "@xper/adapter-shared";
export { createXperExtension } from "./extension.js";
export type { AdapterManifest, BridgeHandshake, BridgeOptions } from "@xper/adapter-shared/bridge";
export {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  decodeFrame,
  decodeMessage,
  encodeFrame,
  errorCode,
} from "@xper/adapter-shared/bridge";
export type {
  RpcError,
  RpcFailureMessage,
  RpcMessage,
  RpcRequest,
  RpcSuccess,
} from "@xper/adapter-shared/bridge";

export { PiWorkflow } from "./pi/workflow.js";
export type { RecorderClient, RecordedEvent, RecordedStatus } from "@xper/adapter-shared/bridge";

// The same versioned definition drives Pi transitions and future read-only views.
export {
  implementationDefinition,
  implementationReworkDefinition,
} from "@xper/adapter-shared";
export { knowledgeDefinition } from "@xper/adapter-shared";
export { verificationDefinition } from "@xper/adapter-shared";
export type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from "@xper/adapter-shared";
