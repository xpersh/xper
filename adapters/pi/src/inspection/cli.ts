import { pathToFileURL } from "node:url";
import { listAvailableModels } from "../execution/models.js";
import { InspectionCatalog } from "./catalog.js";
import { failure, type InspectionResponse, MAX_INSPECTION_FRAME_BYTES } from "./protocol.js";

/** A screen-owned child process. EOF cancels Pi; no socket, daemon, or workflow is started. */
export function runInspection(): void {
  const abort = new AbortController();
  const catalog = new InspectionCatalog(() =>
    listAvailableModels({ cwd: process.cwd(), signal: abort.signal }),
  );
  let buffer = Buffer.alloc(0);
  let closed = false;
  let dropping = false;
  const close = () => {
    closed = true;
    abort.abort();
    process.stdin.pause();
  };
  const send = (response: InspectionResponse) => {
    if (closed) return;
    let line = JSON.stringify(response);
    if (Buffer.byteLength(line) > MAX_INSPECTION_FRAME_BYTES)
      line = JSON.stringify(
        failure(response.id, "RESPONSE_TOO_LARGE", "Inspection response exceeds the frame limit"),
      );
    process.stdout.write(`${line}\n`);
  };
  const accept = (line: Buffer) => {
    let request: unknown;
    try {
      request = JSON.parse(line.toString("utf8"));
    } catch {
      send(failure(null, "INVALID_REQUEST", "Inspection requests must be valid JSON"));
      return;
    }
    void catalog.handle(request).then(send);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    let remaining = chunk;
    while (remaining.length) {
      const end = remaining.indexOf(10);
      const part = end < 0 ? remaining : remaining.subarray(0, end);
      if (!dropping) {
        if (buffer.length + part.length > MAX_INSPECTION_FRAME_BYTES) {
          dropping = true;
          buffer = Buffer.alloc(0);
          send(failure(null, "INVALID_REQUEST", "Inspection request exceeds the frame limit"));
        } else buffer = Buffer.concat([buffer, part]);
      }
      if (end < 0) break;
      if (!dropping) accept(buffer);
      buffer = Buffer.alloc(0);
      dropping = false;
      remaining = remaining.subarray(end + 1);
    }
  });
  process.stdin.on("end", close);
  process.stdin.on("error", close);
  process.stdout.on("error", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runInspection();
