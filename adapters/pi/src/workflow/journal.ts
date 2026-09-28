import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  object,
  recordedEvent,
  type RecordedEvent,
  type RecorderClient,
} from "../bridge/xper-client.js";

export interface JournalData {
  version: 1;
  state: unknown;
  pending: RecordedEvent[];
}
/** Local write-ahead outbox. Persistent ACKs release events; volatile ACKs do not. */
export class WorkflowJournal {
  readonly path: string;
  pending: RecordedEvent[] = [];
  state: unknown = null;
  problem: string | undefined;
  durability: "persistent" | "volatile" = "volatile";
  private localSaved = false;
  constructor(
    cwd: string,
    sessionId: string,
    private readonly recorder: RecorderClient,
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
        !data.pending.every(recordedEvent)
      )
        throw new Error("invalid local workflow journal");
      this.state = data.state;
      this.pending = data.pending;
      this.localSaved = true;
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return;
      throw new Error("Pi workflow journal cannot be read; preserve it before starting a new run", {
        cause: error,
      });
    }
  }
  private async save(): Promise<boolean> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            state: this.state,
            pending: this.pending,
          } satisfies JournalData),
        );
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
      this.localSaved = true;
      return true;
    } catch {
      await unlink(temporary).catch(() => {});
      this.localSaved = false;
      this.problem = "local journal could not be written; unsynced events are held in memory";
      return false;
    }
  }
  async commit(state: unknown, events: RecordedEvent[]): Promise<void> {
    this.state = structuredClone(state);
    this.pending.push(...events);
    await this.save();
    await this.flush();
  }
  async flush(): Promise<void> {
    while (this.pending.length) {
      const batch: RecordedEvent[] = [];
      let bytes = 0;
      for (const event of this.pending) {
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (batch.length && bytes + size > 48000) break;
        if (size > 48000) {
          this.problem = "an event exceeds the recording frame limit; telemetry is pending";
          return;
        }
        batch.push(event);
        bytes += size;
      }
      try {
        const result = await this.recorder.appendEvents(batch);
        this.durability = result.durability;
        if (result.durability !== "persistent") {
          this.problem = "recorder is volatile; events remain pending in the local outbox";
          return;
        }
        this.pending.splice(0, batch.length);
        const saved = await this.save();
        this.problem = saved ? undefined : this.problem;
      } catch {
        this.problem = this.localSaved
          ? "recorder unavailable; events are pending in the local outbox"
          : "recorder and local journal unavailable; events are held in memory";
        return;
      }
    }
  }
}
