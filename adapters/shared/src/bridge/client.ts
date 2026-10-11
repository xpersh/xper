import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  capabilityMap,
  decodeFrame,
  encodeFrame,
  errorCode,
  failure,
  request,
  success,
  type RpcMessage,
  type RpcRequest,
} from "./protocol.js";

export interface AdapterManifest {
  adapter: string;
  adapterVersion: string;
  capabilities: Record<string, boolean>;
}

export interface BridgeOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
}

export interface BridgeHandshake {
  protocolVersion: "1";
  bridgeVersion: string;
  capabilities: Record<string, boolean>;
  maxFrameBytes: number;
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** A single child-process JSONL connection. It dispatches requests in both directions. */
export class BridgeClient {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly manifest: AdapterManifest;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private droppingOversize = false;
  private closed = false;
  private capabilitiesSent = false;
  private readonly exitPromise: Promise<void>;

  constructor(manifest: AdapterManifest, options: BridgeOptions = {}) {
    this.manifest = manifest;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.process = spawn(options.command ?? "xper", options.args ?? ["bridge", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolve) => {
      this.process.once("close", () => resolve());
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.on("error", (error: Error) => this.onClose(error));
    this.process.once("close", (code, signal) => {
      this.onClose(
        new ProtocolFailure(
          errorCode.connectionClosed,
          `bridge closed (exitCode=${code}, signal=${signal})`,
        ),
      );
    });
  }

  private onClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private write(message: RpcMessage, onWritten?: () => void): void {
    if (this.closed || !this.process.stdin.writable) {
      throw new ProtocolFailure(errorCode.connectionClosed, "bridge stdin is closed");
    }
    const frame = encodeFrame(message);
    this.process.stdin.write(frame, (error?: Error | null) => {
      if (error) this.onClose(error);
      else onWritten?.();
    });
  }

  private sendError(error: ProtocolFailure): void {
    try {
      this.write(
        failure(error.id, {
          code: error.code,
          message: error.message,
          ...(error.data ? { data: error.data } : {}),
        }),
      );
    } catch (writeError) {
      this.onClose(writeError as Error);
    }
  }

  private onData(chunk: Buffer): void {
    // Scan for LF before accumulating; oversized frames are discarded without growing memory.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!this.droppingOversize) {
        if (this.buffer.length + part.length > MAX_FRAME_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.droppingOversize = true;
        } else {
          this.buffer = Buffer.concat([this.buffer, part]);
        }
      }
      if (newline < 0) break;
      if (this.droppingOversize) {
        this.sendError(new ProtocolFailure(errorCode.frameTooLarge, "frame too large"));
      } else {
        this.handleFrame(this.buffer);
      }
      this.buffer = Buffer.alloc(0);
      this.droppingOversize = false;
      offset = newline + 1;
    }
  }

  private handleFrame(frame: Buffer): void {
    let message: RpcMessage;
    try {
      message = decodeFrame(frame);
    } catch (error) {
      this.sendError(error as ProtocolFailure);
      return;
    }
    if ("method" in message) {
      this.handleRequest(message);
      return;
    }
    if (message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(
        new ProtocolFailure(
          message.error.code,
          message.error.message,
          message.id,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleRequest(message: RpcRequest): void {
    const empty = Object.keys(message.params).length === 0;
    try {
      switch (message.method) {
        case "capabilities":
          if (!empty)
            throw new ProtocolFailure(errorCode.invalidParams, "invalid params", message.id);
          this.write(success(message.id, { capabilities: this.manifest.capabilities }), () => {
            this.capabilitiesSent = true;
          });
          return;
        case "ping":
          if (!empty)
            throw new ProtocolFailure(errorCode.invalidParams, "invalid params", message.id);
          this.write(success(message.id, { pong: true }));
          return;
        case "shutdown":
          if (!empty)
            throw new ProtocolFailure(errorCode.invalidParams, "invalid params", message.id);
          this.write(success(message.id, { ok: true }));
          return;
        default:
          throw new ProtocolFailure(errorCode.methodNotFound, "method not found", message.id, {
            method: message.method,
          });
      }
    } catch (error) {
      if (error instanceof ProtocolFailure) this.sendError(error);
      else this.onClose(error as Error);
    }
  }

  /** Initiate a correlated request and reject on timeout or process exit. */
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `adapter-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolFailure(errorCode.timeout, `${method} timed out`, id));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(request(id, method, params));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /** Negotiate v1 and confirm that the bridge can also call the adapter. */
  async handshake(): Promise<BridgeHandshake> {
    if (
      !this.manifest.adapter ||
      !this.manifest.adapterVersion ||
      !capabilityMap(this.manifest.capabilities)
    ) {
      throw new ProtocolFailure(errorCode.invalidParams, "invalid adapter manifest");
    }
    const initialized = await this.request("initialize", { ...this.manifest });
    if (
      initialized.protocolVersion !== PROTOCOL_VERSION ||
      typeof initialized.bridgeVersion !== "string" ||
      initialized.bridgeVersion.length === 0
    ) {
      throw new ProtocolFailure(errorCode.invalidRequest, "invalid initialize result");
    }
    const result = await this.request("capabilities");
    if (
      !capabilityMap(result.capabilities) ||
      typeof result.maxFrameBytes !== "number" ||
      !Number.isSafeInteger(result.maxFrameBytes) ||
      result.maxFrameBytes < 1
    ) {
      throw new ProtocolFailure(errorCode.invalidRequest, "invalid capabilities result");
    }
    const deadline = Date.now() + this.requestTimeoutMs;
    while (!this.capabilitiesSent && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!this.capabilitiesSent) {
      throw new ProtocolFailure(errorCode.timeout, "bridge capabilities request timed out");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: initialized.bridgeVersion,
      capabilities: result.capabilities,
      maxFrameBytes: result.maxFrameBytes,
    };
  }

  /** Shut down cleanly; repeated calls are safe. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown");
      this.process.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.exitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ProtocolFailure(errorCode.timeout, "bridge exit timed out")),
              this.requestTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      this.process.kill();
      throw error;
    }
  }

  /** Stop an unusable child process. */
  close(): void {
    if (!this.closed) this.process.kill();
  }
}

/** Spawn and complete a handshake before returning the usable connection. */
export async function connectBridge(
  manifest: AdapterManifest,
  options: BridgeOptions = {},
): Promise<{ client: BridgeClient; handshake: BridgeHandshake }> {
  const client = new BridgeClient(manifest, options);
  try {
    const handshake = await client.handshake();
    return { client, handshake };
  } catch (error) {
    client.close();
    throw error;
  }
}
