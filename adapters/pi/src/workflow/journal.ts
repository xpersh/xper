import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode, ProtocolFailure } from "../bridge/protocol.js";
import {
  object,
  type RecordedEvent,
  type RecorderClient,
  recordedEvent,
} from "../bridge/xper-client.js";

const MAX_EVENT_BYTES = 40 * 1024;
// Leaves room for JSON-RPC framing and correlation IDs within the 64 KiB limit.
const MAX_BATCH_BYTES = 48_000;

type EventRecorder = Pick<RecorderClient, "appendEvents">;

export interface RejectedRecording {
  event: RecordedEvent;
  reason: string;
  code?: number;
}

export interface JournalData {
  version: 1;
  state: unknown;
  pending: RecordedEvent[];
  rejected?: RejectedRecording[];
}

function rejectedRecording(value: unknown): value is RejectedRecording {
  return (
    object(value) &&
    recordedEvent(value.event) &&
    typeof value.reason === "string" &&
    (value.code === undefined || Number.isSafeInteger(value.code))
  );
}

/** Local write-ahead outbox. Workflow operations never await remote recording. */
export class WorkflowJournal {
  readonly path: string;
  pending: RecordedEvent[] = [];
  rejected: RejectedRecording[] = [];
  state: unknown = null;
  problem: string | undefined;
  durability: "persistent" | "volatile" = "volatile";
  private revision = 0;
  private savedRevision = -1;
  private saveTail: Promise<void> = Promise.resolve();
  private delivery: Promise<void> | undefined;
  private deliveryRequested = false;
  private stopped = false;
  private deliveryStart: NodeJS.Immediate | undefined;
  private releaseDeliveryStart: (() => void) | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 250;
  private transportProblem: string | undefined;
  private writeProblem: string | undefined;

  constructor(
    cwd: string,
    sessionId: string,
    private recorder: EventRecorder,
  ) {
    const key = createHash("sha256").update(sessionId).digest("hex");
    this.path = join(cwd, ".xper", "pi", `${key}.json`);
  }

  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !object(data) ||
        data.version !== 1 ||
        !Array.isArray(data.pending) ||
        !data.pending.every(recordedEvent) ||
        (data.rejected !== undefined &&
          (!Array.isArray(data.rejected) || !data.rejected.every(rejectedRecording)))
      )
        throw new Error("invalid local workflow journal");
      this.state = data.state;
      this.pending = data.pending;
      this.rejected = (data.rejected as RejectedRecording[] | undefined) ?? [];
      this.revision++;
      this.savedRevision = this.revision;
      this.updateProblem();
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return;
      throw new Error("Pi workflow journal cannot be read; preserve it before starting a new run", {
        cause: error,
      });
    }
  }

  private updateProblem(): void {
    const messages: string[] = [];
    if (this.writeProblem) messages.push(this.writeProblem);
    if (this.transportProblem) messages.push(this.transportProblem);
    if (this.pending.length) {
      messages.push(
        `${this.pending.length} recording event(s) pending ${this.savedRevision === this.revision ? "in the local outbox" : "in memory until the journal can be saved"}`,
      );
    }
    if (this.rejected.length) {
      messages.push(
        `${this.rejected.length} recording event(s) rejected; retained ${this.savedRevision === this.revision ? "in the local journal" : "in memory until the journal can be saved"} for inspection`,
      );
    }
    this.problem = messages.length ? messages.join("; ") : undefined;
  }

  // Only local writes share this queue. A slow recorder can never hold its lock.
  private save(): Promise<void> {
    const saved = this.saveTail.then(() => this.writeSnapshot());
    this.saveTail = saved;
    return saved;
  }

  private async writeSnapshot(): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const revision = this.revision;
    try {
      const snapshot = JSON.stringify({
        version: 1,
        state: this.state,
        pending: this.pending,
        rejected: this.rejected,
      } satisfies JournalData);
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(snapshot);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.savedRevision = revision;
      this.writeProblem = undefined;
    } catch {
      await unlink(temporary).catch(() => {});
      this.writeProblem = "local journal could not be written; unsynced events are held in memory";
    }
    this.updateProblem();
  }

  /** Save recoverable local state, then schedule delivery without waiting for it. */
  async commit(state: unknown, events: RecordedEvent[]): Promise<void> {
    this.state = structuredClone(state);
    this.pending.push(...structuredClone(events));
    this.revision++;
    await this.save();
    this.flush();
  }

  /** Schedule a single background worker. Calling this never waits for an ACK. */
  flush(): void {
    if (this.stopped || !this.pending.length) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.deliveryRequested = true;
    if (this.delivery) return;
    // Let the workflow's continuation run before starting remote I/O.
    this.delivery = new Promise<void>((resolve) => {
      this.releaseDeliveryStart = resolve;
      this.deliveryStart = setImmediate(() => {
        this.deliveryStart = undefined;
        this.releaseDeliveryStart = undefined;
        resolve();
      });
    })
      .then(async () => {
        if (this.stopped) return;
        do {
          this.deliveryRequested = false;
          await this.deliver();
        } while (this.deliveryRequested && !this.stopped);
      })
      .catch(() => {
        this.transportProblem = "recording delivery failed; events remain pending for inspection";
        this.updateProblem();
        this.scheduleRetry();
      })
      .finally(() => {
        this.delivery = undefined;
      });
  }

  /** Rebind delivery after reconnection without replacing local execution state. */
  setRecorder(recorder: EventRecorder): void {
    this.recorder = recorder;
    this.flush();
  }

  /** Explicit drain for tests and opt-in synchronization, never workflow actions. */
  async waitForIdle(): Promise<void> {
    for (;;) {
      const delivery = this.delivery;
      const saves = this.saveTail;
      await Promise.all([delivery, saves]);
      if (!this.delivery && saves === this.saveTail) return;
    }
  }

  /** Stop timers and ignore late acknowledgements without waiting for remote I/O. */
  stop(): void {
    this.stopped = true;
    this.deliveryRequested = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.deliveryStart) clearImmediate(this.deliveryStart);
    this.deliveryStart = undefined;
    this.releaseDeliveryStart?.();
    this.releaseDeliveryStart = undefined;
  }

  /** Stop delivery and finish local writes without waiting for an in-flight RPC. */
  async close(): Promise<void> {
    this.stop();
    await this.saveTail;
  }

  private scheduleRetry(): void {
    if (this.stopped || !this.pending.length || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.flush();
    }, this.retryDelayMs);
    this.retryTimer.unref();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  private async retainRejected(event: RecordedEvent, reason: string, code?: number): Promise<void> {
    this.pending.shift();
    this.rejected.push({ event, reason, ...(code === undefined ? {} : { code }) });
    this.revision++;
    await this.save();
  }

  private async deliver(): Promise<void> {
    let individual = false;
    while (this.pending.length && !this.stopped) {
      // A commit may have queued another save while the previous save was in flight.
      const saves = this.saveTail;
      await saves;
      if (saves !== this.saveTail) continue;
      if (this.stopped) return;
      const first = this.pending[0];
      if (!first) return;
      if (Buffer.byteLength(JSON.stringify(first)) > MAX_EVENT_BYTES) {
        await this.retainRejected(first, "event exceeds the 40 KiB recording limit");
        continue;
      }
      const batch: RecordedEvent[] = [];
      let bytes = 2;
      for (const event of this.pending) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (
          event.runId !== first.runId ||
          size > MAX_EVENT_BYTES ||
          bytes + size + 1 > MAX_BATCH_BYTES ||
          (individual && batch.length)
        )
          break;
        batch.push(event);
        bytes += size + 1;
      }
      try {
        const result = await this.recorder.appendEvents(batch);
        if (this.stopped) return;
        this.durability = result.durability;
        if (result.durability !== "persistent") {
          this.transportProblem = "recorder is volatile; events remain pending in the local outbox";
          this.updateProblem();
          this.scheduleRetry();
          return;
        }
        this.retryDelayMs = 250;
        this.pending.splice(0, batch.length);
        this.revision++;
        this.transportProblem = undefined;
        await this.save();
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof ProtocolFailure && error.code === errorCode.invalidParams) {
          // Atomic batch rejection does not identify its bad member. Retry one at
          // a time and retain only rejected facts, allowing later valid delivery.
          if (batch.length > 1) {
            individual = true;
            continue;
          }
          await this.retainRejected(first, error.message.slice(0, 500), error.code);
          continue;
        }
        this.transportProblem =
          this.savedRevision === this.revision
            ? "recorder unavailable; events are pending in the local outbox"
            : "recorder and local journal unavailable; events are held in memory";
        this.updateProblem();
        this.scheduleRetry();
        return;
      }
    }
  }
}
