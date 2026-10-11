/** Public v1 JSON-RPC wire contract shared with xper-protocol. */
export const PROTOCOL_VERSION = "1";
export const MAX_FRAME_BYTES = 65_536;

export const errorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  incompatibleVersion: -32001,
  notInitialized: -32002,
  frameTooLarge: -32003,
  timeout: -32004,
  connectionClosed: -32005,
} as const;

export type RpcError = { code: number; message: string; data?: Record<string, unknown> };
export type RpcRequest = {
  jsonrpc: "2.0";
  protocolVersion: "1";
  id: string;
  method: string;
  params: Record<string, unknown>;
};
export type RpcSuccess = {
  jsonrpc: "2.0";
  protocolVersion: "1";
  id: string;
  result: Record<string, unknown>;
};
export type RpcFailureMessage = {
  jsonrpc: "2.0";
  protocolVersion: "1";
  id: string | null;
  error: RpcError;
};
export type RpcMessage = RpcRequest | RpcSuccess | RpcFailureMessage;

export class ProtocolFailure extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly id: string | null = null,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProtocolFailure";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function capabilityMap(value: unknown): value is Record<string, boolean> {
  return object(value) && Object.values(value).every((item) => typeof item === "boolean");
}

/** Parse an envelope. Method-specific argument checks happen in the handler. */
export function decodeMessage(value: unknown): RpcMessage {
  if (!object(value)) {
    throw new ProtocolFailure(errorCode.invalidRequest, "message must be an object");
  }
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  if (value.jsonrpc !== "2.0") {
    throw new ProtocolFailure(errorCode.invalidRequest, "expected jsonrpc 2.0", id);
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    if (typeof value.protocolVersion === "string") {
      throw new ProtocolFailure(
        errorCode.incompatibleVersion,
        "incompatible protocol version",
        id,
        {
          received: value.protocolVersion,
          supported: [PROTOCOL_VERSION],
        },
      );
    }
    throw new ProtocolFailure(errorCode.invalidRequest, "missing protocolVersion", id);
  }
  if ("method" in value) {
    if (id === null) {
      throw new ProtocolFailure(errorCode.invalidRequest, "request requires a nonempty string id");
    }
    if ("result" in value || "error" in value) {
      throw new ProtocolFailure(errorCode.invalidRequest, "request cannot contain a response", id);
    }
    if (typeof value.method !== "string" || value.method.length === 0) {
      throw new ProtocolFailure(errorCode.invalidRequest, "method must be a nonempty string", id);
    }
    if (!object(value.params)) {
      throw new ProtocolFailure(errorCode.invalidRequest, "params must be an object", id);
    }
    return {
      jsonrpc: "2.0",
      protocolVersion: PROTOCOL_VERSION,
      id,
      method: value.method,
      params: value.params,
    };
  }
  if ("result" in value === "error" in value) {
    throw new ProtocolFailure(
      errorCode.invalidRequest,
      "response requires exactly one of result or error",
      id,
    );
  }
  if ("result" in value) {
    if (id === null) {
      throw new ProtocolFailure(errorCode.invalidRequest, "response requires a nonempty string id");
    }
    if (!object(value.result)) {
      throw new ProtocolFailure(errorCode.invalidRequest, "result must be an object", id);
    }
    return { jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, id, result: value.result };
  }
  if (!object(value.error)) {
    throw new ProtocolFailure(errorCode.invalidRequest, "error must be an object", id);
  }
  if (!Number.isSafeInteger(value.error.code)) {
    throw new ProtocolFailure(errorCode.invalidRequest, "error code must be an integer", id);
  }
  if (typeof value.error.message !== "string") {
    throw new ProtocolFailure(errorCode.invalidRequest, "error message must be a string", id);
  }
  if (value.id !== null && id === null) {
    throw new ProtocolFailure(errorCode.invalidRequest, "error id must be a string or null");
  }
  if ("data" in value.error && !object(value.error.data)) {
    throw new ProtocolFailure(errorCode.invalidRequest, "error data must be an object", id);
  }
  const error: RpcError = { code: value.error.code as number, message: value.error.message };
  if ("data" in value.error) error.data = value.error.data as Record<string, unknown>;
  return { jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, id, error };
}

export function decodeFrame(frame: Buffer): RpcMessage {
  if (frame.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFailure(errorCode.frameTooLarge, "frame too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame.toString("utf8"));
  } catch {
    throw new ProtocolFailure(errorCode.parseError, "invalid JSON");
  }
  return decodeMessage(value);
}

export function request(id: string, method: string, params: Record<string, unknown>): RpcRequest {
  return { jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, id, method, params };
}

export function success(id: string, result: Record<string, unknown>): RpcSuccess {
  return { jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, id, result };
}

export function failure(id: string | null, error: RpcError): RpcFailureMessage {
  return { jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, id, error };
}

export function encodeFrame(message: RpcMessage): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  if (bytes.byteLength - 1 > MAX_FRAME_BYTES) {
    throw new ProtocolFailure(errorCode.frameTooLarge, "frame too large", message.id);
  }
  return bytes;
}
