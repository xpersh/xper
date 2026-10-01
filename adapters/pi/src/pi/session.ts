import { BridgeClient, type BridgeHandshake, type BridgeOptions } from "../bridge/client.js";
import { ProtocolFailure, errorCode } from "../bridge/protocol.js";
import { XperClient, type RecorderClient } from "../bridge/xper-client.js";
import { listAvailableModels } from "../execution/models.js";
import { PiWorkflow } from "../workflow/controller.js";
import type { RunStatus } from "../workflow/types.js";
import { PreparedConfiguration } from "./configuration.js";
import { PiObservations } from "./observations.js";
import type { PiContext } from "./types.js";

const ADAPTER_VERSION = "0.1.0";
const STATUS_KEY = "xper";

export interface ActiveBridge {
  client: BridgeClient;
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

/** Workflow lifetime is independent of the optional recording/configuration bridge. */
export class XperSession {
  private active: ActiveBridge | undefined;
  private connecting: Promise<void> | undefined;
  private pendingClient: BridgeClient | undefined;
  private localStarting: Promise<void> | undefined;
  private localWorkflow: PiWorkflow | undefined;
  private configuration: PreparedConfiguration | undefined;
  private recorder: XperClient | undefined;
  private identity: string | undefined;
  private generation = 0;
  private stopping = false;
  private lastError: string | undefined;
  private observations: PiObservations | undefined;
  private lastRun: RunStatus | undefined;
  private readonly observationsFile: string | undefined;
  private readonly bridgeOptions: BridgeOptions;
  private readonly recorderProxy: RecorderClient = {
    appendEvents: (events) => this.recordingClient().appendEvents(events),
    getRunStatus: (runId) => this.recordingClient().getRunStatus(runId),
    inspectProfile: () => this.recordingClient().inspectProfile(),
    resolveConfiguration: (models) => this.recordingClient().resolveConfiguration(models),
  };

  constructor(options: BridgeOptions & { observationsFile?: string } = {}) {
    const { observationsFile = process.env.XPER_PI_OBSERVATIONS_FILE, ...bridgeOptions } = options;
    this.observationsFile = observationsFile;
    this.bridgeOptions = bridgeOptions;
  }
  private recordingClient(): XperClient {
    if (!this.recorder) throw new Error("xper recorder offline");
    return this.recorder;
  }
  get connection(): ActiveBridge | undefined {
    return this.active;
  }
  get workflow(): PiWorkflow | undefined {
    return this.localWorkflow;
  }
  get error(): string | undefined {
    return this.lastError;
  }
  get observation(): PiObservations | undefined {
    return this.observations;
  }
  configurationSummary(): string {
    return this.configuration?.summary() ?? "Pi defaults; configuration is not prepared";
  }
  phaseSummary(): string {
    const run = this.lastRun?.run;
    if (!run) return "; no run";
    const judgment = this.lastRun?.judgment;
    const closure = this.lastRun?.closure;
    const telemetry = this.lastRun?.degradedReason
      ? `; telemetry: ${this.lastRun.degradedReason}`
      : "";
    const phase = run.visits.at(-1)?.phase ?? "?";
    const implementation = Object.values(this.lastRun?.implementations ?? {})[0];
    const verification = Object.values(this.lastRun?.verifications ?? {})[0];
    const routing = run.routing ? `profile ${run.routing.profile}` : "Pi model";
    const outcomes = Object.values(run.attempts).map((attempt) => attempt.outcome ?? "running");
    const gate = closure
      ? `; closed: ${closure.status}; report ${closure.reportId}; evaluated ${closure.evaluatedCommit}; [Run summary](${closure.summary.path})`
      : judgment
        ? `; judgment ${judgment.verdict ?? judgment.status}; evaluated ${judgment.evaluatedCommit}; ${judgment.artifactId ? `report ${judgment.artifactId} (${judgment.artifactPath}); recommendation not applied; ${["ACCEPT", "REJECT"].includes(judgment.verdict ?? "") ? `apply with /xper approve ${judgment.artifactId} ${judgment.evaluatedCommit}` : "handling this verdict is unsupported; pending"}` : `retry with assignmentId ${judgment.assignmentId}`}`
        : this.lastRun?.reconciliation?.status === "awaiting_resume"
          ? "; revised plan ready: /xper resume <commit>"
          : implementation?.nodeId === "implement"
            ? `; implementation ${implementation.status}`
            : verification
              ? `; verification ${verification.nodeId}`
              : implementation
                ? `; implementation ${implementation.status}`
                : run.human_input
                  ? `; awaiting approval: /xper approve ${run.human_input[1]}`
                  : run.accepted?.plan
                    ? "; execution plan ready"
                    : "";
    return `; run ${run.run_id}; phase ${phase}; run configuration: ${routing}; attempts ${outcomes.join(", ") || "none"}; artifacts ${Object.keys(run.artifacts).length}${gate}${telemetry}`;
  }
  async refreshRun(): Promise<void> {
    if (this.localWorkflow) this.lastRun = await this.localWorkflow.getRunStatus();
  }
  private showStatus(ctx: PiContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(
      STATUS_KEY,
      this.active ? "xper connected" : this.localWorkflow ? "xper recorder offline" : undefined,
    );
  }
  private fail(ctx: PiContext, error: unknown): void {
    this.observations?.record("bridge.error", {
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: error instanceof ProtocolFailure ? error.code : null,
    });
    this.lastError = actionableError(error);
    this.recorder = undefined;
    const connection = this.active;
    this.active = undefined;
    connection?.client.close();
    this.showStatus(ctx);
    ctx.ui.notify(`xper: ${this.lastError} Local workflow remains available.`, "warning");
  }
  private connect(ctx: PiContext): void {
    if (this.active || this.connecting || this.stopping) return;
    const generation = this.generation;
    const client = new BridgeClient(manifest, {
      command: process.env.XPER_BRIDGE_COMMAND ?? "xper",
      ...this.bridgeOptions,
    });
    this.pendingClient = client;
    this.connecting = (async () => {
      try {
        const handshake = await client.handshake();
        if (generation !== this.generation || this.stopping) return;
        if (
          !handshake.capabilities.eventRecording ||
          !handshake.capabilities.configurationResolution
        )
          throw new Error(
            "bridge lacks passive recording/configuration capabilities; rebuild or upgrade xper",
          );
        const sessionId = ctx.sessionManager.getSessionId();
        await client.request("session.attach", { sessionId, cwd: ctx.cwd, mode: ctx.mode });
        if (generation !== this.generation || this.stopping) return;
        const recorder = new XperClient(client);
        this.recorder = recorder;
        this.active = { client, handshake, sessionId };
        this.lastError = undefined;
        this.localWorkflow?.syncRecording();
        this.observations?.record("bridge.connected", {
          bridgeVersion: handshake.bridgeVersion,
          protocolVersion: handshake.protocolVersion,
          pid: client.process.pid ?? null,
        });
        client.process.once("close", (code, signal) => {
          if (this.stopping || this.active?.client !== client) return;
          this.observations?.record("bridge.exited", { exitCode: code, signal });
          this.fail(ctx, new Error(`bridge exited (code=${code}, signal=${signal})`));
        });
        this.showStatus(ctx);
        // Preparation can be slow or unavailable without delaying any workflow operation.
        void this.prepareConfiguration(ctx, recorder, generation);
      } catch (error) {
        client.close();
        if (generation === this.generation && !this.stopping) this.fail(ctx, error);
      } finally {
        if (this.pendingClient === client) this.pendingClient = undefined;
        if (generation === this.generation) this.connecting = undefined;
        if (generation !== this.generation || this.stopping) client.close();
      }
    })();
  }
  private async prepareConfiguration(
    ctx: PiContext,
    recorder: XperClient,
    generation: number,
  ): Promise<void> {
    try {
      const profile = await recorder.inspectProfile();
      const models = profile ? await listAvailableModels() : undefined;
      const configuration = await recorder.resolveConfiguration(models);
      if (generation !== this.generation || this.recorder !== recorder || this.stopping) return;
      await this.configuration?.update(configuration);
    } catch (error) {
      if (generation !== this.generation || this.recorder !== recorder || this.stopping) return;
      if (this.configuration)
        this.configuration.problem = `configuration preparation unavailable (${error instanceof Error ? error.message : "unknown error"})`;
      ctx.ui.notify(
        `xper: ${this.configurationSummary()}. Existing runs keep their frozen configuration.`,
        "warning",
      );
    }
  }
  async start(ctx: PiContext, reason: string): Promise<void> {
    if (this.localStarting) return this.localStarting;
    const identity = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
    if (this.identity && this.identity !== identity) await this.stop(ctx, "session_changed");
    this.stopping = false;
    if (this.identity !== identity || !this.localWorkflow) {
      this.identity = identity;
      this.configuration = new PreparedConfiguration(ctx.cwd);
      this.localWorkflow = new PiWorkflow(
        this.recorderProxy,
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        { configuration: () => this.configuration?.snapshot ?? null },
      );
      this.observations = new PiObservations(this.observationsFile, () =>
        ctx.ui.notify(
          "xper: observation log could not be written; in-memory counts remain available",
          "warning",
        ),
      );
      this.observations.record("session.start", {
        reason,
        mode: ctx.mode,
        adapterVersion: ADAPTER_VERSION,
      });
      this.localStarting = (async () => {
        await this.configuration?.load();
        await this.refreshRun();
      })();
      try {
        await this.localStarting;
      } finally {
        this.localStarting = undefined;
      }
    }
    this.showStatus(ctx);
    this.connect(ctx);
  }
  async stop(ctx: PiContext, reason: string): Promise<void> {
    this.stopping = true;
    this.generation++;
    await this.localWorkflow?.stopRecording();
    this.pendingClient?.close();
    this.pendingClient = undefined;
    this.connecting = undefined;
    const connection = this.active;
    this.active = undefined;
    this.recorder = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (connection) {
      // Graceful shutdown is best effort; Rust cannot hold Pi's lifecycle open.
      const timer = setTimeout(() => connection.client.close(), 250);
      void connection.client
        .shutdown()
        .catch(() => connection.client.close())
        .finally(() => clearTimeout(timer));
    }
    await this.observations?.sessionEnded(reason);
    // A later session_start creates a fresh local controller after a real shutdown.
    this.identity = undefined;
    this.localWorkflow = undefined;
    this.configuration = undefined;
    this.lastRun = undefined;
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
