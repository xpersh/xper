import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CommandResult {
  exitCode: number;
  outputPath: string;
  timedOut: boolean;
  cancelled: boolean;
}

export function runTestCommand(
  command: string,
  cwd: string,
  attemptId: string,
  index: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  const outputPath = `.xper/artifacts/test-output-${attemptId}-${index + 1}.log`;
  if (signal.aborted)
    return Promise.resolve({ exitCode: 130, outputPath, timedOut: false, cancelled: true });
  const detached = process.platform !== "win32";
  const child = spawn(command, {
    cwd,
    shell: true,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveResult) => {
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let finished = false;
    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output) >= 1_000_000) return;
      output += chunk.toString("utf8").slice(0, 1_000_000 - Buffer.byteLength(output));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* Fall through when the process already exited. */
        }
      }
      child.kill("SIGKILL");
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, timeoutMs),
    );
    const done = async (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await mkdir(join(cwd, ".xper", "artifacts"), { recursive: true });
      await writeFile(join(cwd, outputPath), output, { flag: "wx" });
      resolveResult({ exitCode, outputPath, timedOut, cancelled });
    };
    child.on("error", () => void done(127));
    child.on(
      "close",
      (code, terminationSignal) =>
        void done(cancelled ? 130 : timedOut ? 124 : terminationSignal ? 128 : (code ?? 1)),
    );
  });
}
