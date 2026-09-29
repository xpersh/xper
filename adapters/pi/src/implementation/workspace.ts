import { spawn, execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitWorkspace {
  root: string;
  head: string;
  clean: boolean;
  status: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return stdout.trim();
}

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspace> {
  let root: string;
  let head: string;
  try {
    [root, head] = await Promise.all([
      git(cwd, ["rev-parse", "--show-toplevel"]),
      git(cwd, ["rev-parse", "HEAD"]),
    ]);
  } catch {
    throw new Error("implementation requires an existing Git checkout with a local commit");
  }
  if (resolve(await realpath(root)) !== resolve(await realpath(cwd)))
    throw new Error("implementation must run from the root of its dedicated Git checkout");
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { root, head, clean: status.length === 0, status };
}

export async function isDescendant(cwd: string, base: string, head: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", base, head], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const output = await git(cwd, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head]);
  return output ? output.split("\n").filter(Boolean) : [];
}

export interface CommandResult {
  exitCode: number;
  outputPath: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** Execute one declared test and keep bounded combined output as local evidence. */
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
