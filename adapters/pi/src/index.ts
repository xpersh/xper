/** Scaffold metadata for the Pi adapter package. */
export const adapterPackage = {
  harness: "pi",
  packageName: "@xper/adapter-pi",
  protocolBoundary: "public",
} as const;

export { BridgeClient, connectBridge } from "./bridge/client.js";
export { XperClient } from "./bridge/xper-client.js";
export type {
  WorkflowClient,
  WorkflowPosition,
  RunStarted,
  AssignmentStarted,
  KnowledgeAssignmentStarted,
  ImplementationAssignmentStarted,
  StartedAssignment,
  ImplementationCriterion,
  FinishAttempt,
  AttemptFinished,
  AttemptOutcome,
  RunAdvanced,
  RunSummary,
  RunStatus,
} from "./workflow/types.js";
export { createXperExtension } from "./extension.js";
export type { AdapterManifest, BridgeHandshake, BridgeOptions } from "./bridge/client.js";
export {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  decodeFrame,
  decodeMessage,
  encodeFrame,
  errorCode,
} from "./bridge/protocol.js";
export type {
  RpcError,
  RpcFailureMessage,
  RpcMessage,
  RpcRequest,
  RpcSuccess,
} from "./bridge/protocol.js";

export { PiWorkflow } from "./workflow/controller.js";
export type { RecorderClient, RecordedEvent, RecordedStatus } from "./bridge/xper-client.js";

// The same versioned definition drives Pi transitions and future read-only views.
export { implementationDefinition, knowledgeDefinition } from "./workflow/definition.js";
export type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from "./workflow/definition.js";
