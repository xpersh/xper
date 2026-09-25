import {
  connectBridge,
  type BridgeClient,
  type BridgeHandshake,
  type BridgeOptions,
} from "./bridge.js";
import { PROTOCOL_VERSION, ProtocolFailure, errorCode } from "./protocol.js";
import { PiObservations, isPiToolError, type PiToolEndEvent } from "./observations.js";

export { isPiToolError } from "./observations.js";

const ADAPTER_VERSION = "0.1.0";
const TESTED_OPEN_AGENTS_VERSION = "0.1.22";
const STATUS_KEY = "xper";

/** The small part of Pi's extension API used by this adapter. */
interface PiContext {
  cwd: string;
  mode: string;
  sessionManager: { getSessionId(): string };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

interface PiExtensionAPI {
  on(
    event: "session_start",
    handler: (event: { reason: string }, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: { reason: string }, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_compact_failed",
    handler: (event: { type: string }, ctx: PiContext) => void,
  ): void;
  on(
    event: "tool_execution_start",
    handler: (event: { toolName: string; toolCallId: string }, ctx: PiContext) => void,
  ): void;
  on(event: "tool_execution_end", handler: (event: PiToolEndEvent, ctx: PiContext) => void): void;
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: PiContext) => void },
  ): void;
}

interface ActiveBridge {
  client: BridgeClient;
  handshake: BridgeHandshake;
  sessionId: string;
}

const manifest = {
  adapter: "pi",
  adapterVersion: ADAPTER_VERSION,
  capabilities: {
    primaryAgent: true,
    lifecycleEvents: true,
    nativeUi: true,
    subagents: false,
  },
};

function actionableError(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "xper binary not found. Build it with `cargo build -p xper-cli` and put target/debug on PATH, or set XPER_BRIDGE_COMMAND to its path.";
  }
  if (error instanceof ProtocolFailure) {
    if (
      error.code === errorCode.incompatibleVersion ||
      error.code === errorCode.methodNotFound ||
      error.code === errorCode.invalidRequest
    ) {
      return `incompatible xper bridge (${error.message}). Rebuild xper and the Pi adapter from the same checkout.`;
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `xper bridge unavailable (${detail}). Check that \`xper bridge --stdio\` runs, then use /reload in Pi.`;
}

/** Register a Pi extension. Process creation is deferred until session_start. */
export function createXperExtension(
  pi: PiExtensionAPI,
  options: BridgeOptions & { observationsFile?: string } = {},
): void {
  const { observationsFile = process.env.XPER_PI_OBSERVATIONS_FILE, ...bridgeOptions } = options;
  let active: ActiveBridge | undefined;
  let starting: Promise<void> | undefined;
  let stopping = false;
  let lastError: string | undefined;
  let observations: PiObservations | undefined;

  function showStatus(ctx: PiContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(
      STATUS_KEY,
      active ? "xper connected" : lastError ? "xper offline" : undefined,
    );
  }

  function fail(ctx: PiContext, error: unknown): void {
    observations?.record("bridge.error", {
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: error instanceof ProtocolFailure ? error.code : null,
    });
    lastError = actionableError(error);
    active?.client.close();
    active = undefined;
    showStatus(ctx);
    ctx.ui.notify(`xper: ${lastError}`, "warning");
  }

  async function start(ctx: PiContext, reason: string): Promise<void> {
    if (active || starting) return starting;
    stopping = false;
    lastError = undefined;
    observations = new PiObservations(observationsFile, () => {
      ctx.ui.notify(
        "xper: observation log could not be written; in-memory counts remain available",
        "warning",
      );
    });
    observations.record("session.start", {
      reason,
      mode: ctx.mode,
      adapterVersion: ADAPTER_VERSION,
      testedOpenAgentsVersion: TESTED_OPEN_AGENTS_VERSION,
    });
    starting = (async () => {
      let client: BridgeClient | undefined;
      try {
        const connected = await connectBridge(manifest, {
          command: process.env.XPER_BRIDGE_COMMAND ?? "xper",
          ...bridgeOptions,
        });
        client = connected.client;
        if (stopping) {
          await client.shutdown();
          return;
        }
        const sessionId = ctx.sessionManager.getSessionId();
        await client.request("session.attach", { sessionId, cwd: ctx.cwd, mode: ctx.mode });
        if (stopping) {
          await client.shutdown();
          return;
        }
        active = { client, handshake: connected.handshake, sessionId };
        observations?.record("bridge.connected", {
          bridgeVersion: connected.handshake.bridgeVersion,
          protocolVersion: connected.handshake.protocolVersion,
          pid: client.process.pid ?? null,
        });
        client.process.once("close", (code, signal) => {
          if (stopping || active?.client !== client) return;
          observations?.record("bridge.exited", { exitCode: code, signal });
          fail(ctx, new Error(`bridge exited (code=${code}, signal=${signal})`));
        });
        showStatus(ctx);
      } catch (error) {
        client?.close();
        if (!stopping) fail(ctx, error);
      }
    })();
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  }

  async function stop(ctx: PiContext, reason: string): Promise<void> {
    stopping = true;
    await starting;
    const connection = active;
    active = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (connection) {
      try {
        await connection.client.request("session.detach", { sessionId: connection.sessionId });
        await connection.client.shutdown();
        observations?.record("bridge.closed", { graceful: true });
      } catch {
        connection.client.close();
        observations?.record("bridge.closed", { graceful: false });
      }
    }
    await observations?.sessionEnded(reason);
    stopping = false;
  }

  function forwardError(ctx: PiContext, source: string, toolCallId?: string): void {
    const connection = active;
    if (!connection) return;
    void connection.client
      .request("event.ingest", {
        sessionId: connection.sessionId,
        kind: "error",
        source,
        ...(toolCallId ? { toolCallId } : {}),
      })
      .catch((error: unknown) => {
        if (active?.client === connection.client && !stopping) fail(ctx, error);
      });
  }

  pi.registerCommand("xper", {
    description: "Show xper bridge status with /xper status",
    handler: (args, ctx) => {
      observations?.record("command.invoked", {
        command: "xper",
        recognized: args.trim() === "status",
        bridgeConnected: active !== undefined,
      });
      if (args.trim() !== "status") {
        ctx.ui.notify("Usage: /xper status", "info");
        return;
      }
      const state = active
        ? `connected (pid ${active.client.process.pid ?? "?"}, bridge ${active.handshake.bridgeVersion})`
        : `offline${lastError ? `: ${lastError}` : ""}`;
      const counts = observations?.summary();
      const observed = counts
        ? `; subagent observed: started ${counts.started}, reported done ${counts.reportedDone}, reported error ${counts.reportedError}, unclassified ${counts.unclassified}, in flight ${counts.inFlight}, mismatches ${counts.mismatches}, unpaired ${counts.unpaired}`
        : "";
      ctx.ui.notify(
        `xper adapter pi ${ADAPTER_VERSION}; protocol ${PROTOCOL_VERSION}; bridge ${state}${observed}`,
        active ? "info" : "warning",
      );
    },
  });

  pi.on("session_start", async (event, ctx) => start(ctx, event.reason));
  pi.on("session_shutdown", async (event, ctx) => stop(ctx, event.reason));
  pi.on("session_compact_failed", (_event, ctx) => forwardError(ctx, "session_compact"));
  pi.on("tool_execution_start", (event) => {
    observations?.toolStarted(event.toolName, event.toolCallId);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    // This is an observation only. Delegation outcomes and cancellation are not inferred here.
    observations?.toolEnded(event);
    if (isPiToolError(event)) forwardError(ctx, `tool:${event.toolName}`, event.toolCallId);
  });
}

export default createXperExtension;
