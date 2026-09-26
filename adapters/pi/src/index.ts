/** Scaffold metadata for the Pi adapter package. */
export const adapterPackage = {
  harness: "pi",
  packageName: "@xper/adapter-pi",
  protocolBoundary: "public",
} as const;

export { BridgeClient, connectBridge } from "./bridge/client.js";
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
