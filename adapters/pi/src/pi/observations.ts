import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createLogger, format, transports, type Logger } from "winston";

export interface PiToolEndEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
  result?: { details?: unknown };
}

interface ObservationCounts {
  started: number;
  completed: number;
  failed: number;
  unpaired: number;
  inFlight: number;
}

type ObservationFields = Record<string, string | number | boolean | null>;

interface LogRotation {
  maxBytes: number;
  maxFiles: number;
}

const DEFAULT_ROTATION: LogRotation = { maxBytes: 5 * 1024 * 1024, maxFiles: 5 };

/** Session-local, metadata-only observations; an optional rotating JSONL log survives Pi restarts. */
export class PiObservations {
  private readonly correlationId = randomUUID();
  private readonly starts = new Map<string, number>();
  private logger: Logger | undefined;
  private writeFailed = false;
  private ended = false;
  private readonly counts: ObservationCounts = {
    started: 0,
    completed: 0,
    failed: 0,
    unpaired: 0,
    inFlight: 0,
  };

  constructor(
    filePath: string | undefined,
    private readonly onWriteError: () => void,
    rotation: LogRotation = DEFAULT_ROTATION,
  ) {
    if (!filePath) return;
    try {
      // Winston's file transport can silently discard writes when the target cannot open.
      closeSync(openSync(filePath, "a", 0o600));
      const file = new transports.File({
        filename: filePath,
        maxsize: rotation.maxBytes,
        maxFiles: rotation.maxFiles,
        tailable: true,
        options: { flags: "a", mode: 0o600 },
      });
      file.on("error", () => this.writeError());
      this.logger = createLogger({
        level: "info",
        format: format.json(),
        transports: [file],
      });
      this.logger.on("error", () => this.writeError());
    } catch {
      this.writeError();
    }
  }

  private writeError(): void {
    if (this.writeFailed) return;
    this.writeFailed = true;
    this.onWriteError();
  }

  summary(): ObservationCounts {
    return { ...this.counts, inFlight: this.starts.size };
  }

  record(type: string, fields: ObservationFields = {}): void {
    if (!this.logger || this.writeFailed || this.ended) return;
    try {
      this.logger.info(type, {
        at: new Date().toISOString(),
        session: this.correlationId,
        type,
        ...fields,
      });
    } catch {
      this.writeError();
    }
  }

  toolStarted(toolName: string, toolCallId: string): void {
    this.counts.started++;
    this.starts.set(toolCallId, Date.now());
    this.record("tool.start", { toolName, toolCallId });
  }

  toolEnded(event: PiToolEndEvent): void {
    const startedAt = this.starts.get(event.toolCallId);
    this.starts.delete(event.toolCallId);
    if (startedAt === undefined) this.counts.unpaired++;

    if (event.isError) this.counts.failed++;
    else this.counts.completed++;

    this.record("tool.end", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      elapsedMs: startedAt === undefined ? null : Date.now() - startedAt,
    });
  }

  async sessionEnded(reason: string): Promise<void> {
    if (this.ended) return;
    for (const [toolCallId, startedAt] of this.starts) {
      this.counts.unpaired++;
      this.record("tool.unpaired", { toolCallId, elapsedMs: Date.now() - startedAt });
    }
    this.starts.clear();
    this.record("session.end", { reason, ...this.summary() });
    this.ended = true;
    const logger = this.logger;
    this.logger = undefined;
    if (!logger) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        logger.off("finish", finish);
        logger.off("error", finish);
        logger.close();
        resolve();
      };
      const timeout = setTimeout(() => {
        this.writeError();
        finish();
      }, 2_000);
      logger.once("finish", finish);
      logger.once("error", finish);
      try {
        logger.end();
      } catch {
        this.writeError();
        finish();
      }
    });
  }
}
