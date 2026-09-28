import {
  connectBridge,
  type BridgeClient,
  type BridgeHandshake,
  type BridgeOptions,
} from "../bridge/client.js";
import type { RunStatus } from "../workflow/types.js";
import { XperClient } from "../bridge/xper-client.js";
import { PiWorkflow } from "../workflow/controller.js";
import { PiObservations } from "./observations.js";
import type { PiContext } from "./types.js";
import { ProtocolFailure, errorCode } from "../bridge/protocol.js";

const ADAPTER_VERSION = "0.1.0";
const STATUS_KEY = "xper";

export interface ActiveBridge {
  client: BridgeClient;
  workflow: PiWorkflow;
  handshake: BridgeHandshake;
  sessionId: string;
}

const manifest = {
  adapter: "pi",
  adapterVersion: ADAPTER_VERSION,
  capabilities: {
    primaryAgent: false,
    lifecycleEvents: true,
    nativeUi: true,
    humanApproval: true,
    subagents: true,
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

/** Session-local bridge, projected status, and observations shared by Pi registrations. */
export class XperSession {
  private active: ActiveBridge | undefined;
  private starting: Promise<void> | undefined;
  private stopping = false;
  private lastError: string | undefined;
  private observations: PiObservations | undefined;
  private lastRun: RunStatus | undefined;
  private readonly observationsFile: string | undefined;
  private readonly bridgeOptions: BridgeOptions;

  constructor(options: BridgeOptions & { observationsFile?: string } = {}) {
    const { observationsFile = process.env.XPER_PI_OBSERVATIONS_FILE, ...bridgeOptions } = options;
    this.observationsFile = observationsFile;
    this.bridgeOptions = bridgeOptions;
  }

  get connection(): ActiveBridge | undefined {
    return this.active;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get observation(): PiObservations | undefined {
    return this.observations;
  }

  phaseSummary(): string {
    const run = this.lastRun?.run;
    if (!run) return "; no run";
    const telemetry = this.lastRun?.degradedReason
      ? `; telemetry: ${this.lastRun.degradedReason}`
      : "";
    const phase = run.visits.at(-1)?.phase ?? "?";
    const outcomes = Object.values(run.attempts).map((attempt) => attempt.outcome ?? "running");
    const gate = run.human_input
      ? `; awaiting approval: /xper approve ${run.human_input[1]}`
      : run.accepted?.plan
        ? "; execution plan ready"
        : "";
    return `; run ${run.run_id}; phase ${phase}; attempts ${outcomes.join(", ") || "none"}; artifacts ${Object.keys(run.artifacts).length}${gate}${telemetry}`;
  }

  async refreshRun(): Promise<void> {
    if (this.active) this.lastRun = await this.active.workflow.getRunStatus();
  }

  private showStatus(ctx: PiContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(
      STATUS_KEY,
      this.lastError ? "xper recorder offline" : this.active ? "xper connected" : undefined,
    );
  }

  private fail(ctx: PiContext, error: unknown): void {
    this.observations?.record("bridge.error", {
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: error instanceof ProtocolFailure ? error.code : null,
    });
    this.lastError = actionableError(error);
    this.active?.client.close();
    this.showStatus(ctx);
    ctx.ui.notify(`xper: ${this.lastError}`, "warning");
  }

  async start(ctx: PiContext, reason: string): Promise<void> {
    if ((this.active && !this.lastError) || this.starting) return this.starting;
    this.stopping = false;
    this.lastError = undefined;
    this.observations = new PiObservations(this.observationsFile, () => {
      ctx.ui.notify(
        "xper: observation log could not be written; in-memory counts remain available",
        "warning",
      );
    });
    this.observations.record("session.start", {
      reason,
      mode: ctx.mode,
      adapterVersion: ADAPTER_VERSION,
    });
    this.starting = (async () => {
      let client: BridgeClient | undefined;
      try {
        const connected = await connectBridge(manifest, {
          command: process.env.XPER_BRIDGE_COMMAND ?? "xper",
          ...this.bridgeOptions,
        });
        client = connected.client;
        if (this.stopping) {
          await client.shutdown();
          return;
        }
        if (
          !connected.handshake.capabilities.eventRecording ||
          !connected.handshake.capabilities.configurationResolution
        ) {
          throw new Error(
            "bridge lacks passive recording/configuration capabilities; rebuild or upgrade xper",
          );
        }
        const sessionId = ctx.sessionManager.getSessionId();
        await client.request("session.attach", { sessionId, cwd: ctx.cwd, mode: ctx.mode });
        if (this.stopping) {
          await client.shutdown();
          return;
        }
        this.active = {
          client,
          workflow: new PiWorkflow(new XperClient(client), ctx.cwd, sessionId),
          handshake: connected.handshake,
          sessionId,
        };
        await this.refreshRun();
        this.observations?.record("bridge.connected", {
          bridgeVersion: connected.handshake.bridgeVersion,
          protocolVersion: connected.handshake.protocolVersion,
          pid: client.process.pid ?? null,
        });
        client.process.once("close", (code, signal) => {
          if (this.stopping || this.active?.client !== client) return;
          this.observations?.record("bridge.exited", { exitCode: code, signal });
          this.fail(ctx, new Error(`bridge exited (code=${code}, signal=${signal})`));
        });
        this.showStatus(ctx);
      } catch (error) {
        client?.close();
        if (!this.stopping) this.fail(ctx, error);
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async stop(ctx: PiContext, reason: string): Promise<void> {
    this.stopping = true;
    await this.starting;
    const connection = this.active;
    this.active = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (connection) {
      try {
        await connection.client.request("session.detach", { sessionId: connection.sessionId });
        await connection.client.shutdown();
        this.observations?.record("bridge.closed", { graceful: true });
      } catch {
        connection.client.close();
        this.observations?.record("bridge.closed", { graceful: false });
      }
    }
    await this.observations?.sessionEnded(reason);
    this.stopping = false;
  }

  forwardError(ctx: PiContext, source: string, toolCallId?: string): void {
    const connection = this.active;
    if (!connection) return;
    void connection.client
      .request("event.ingest", {
        sessionId: connection.sessionId,
        kind: "error",
        source,
        ...(toolCallId ? { toolCallId } : {}),
      })
      .catch((error: unknown) => {
        if (this.active?.client === connection.client && !this.stopping) this.fail(ctx, error);
      });
  }
}

export { ADAPTER_VERSION };
