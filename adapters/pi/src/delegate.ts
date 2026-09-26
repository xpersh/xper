import { spawn } from "node:child_process";

export type DelegateOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
export interface DelegateResult {
  outcome: DelegateOutcome;
  brief?: string;
}

/** The first supported xper role is resolved inside the adapter, never in the core. */
export function resolveAgent(role: string): { name: string; systemPrompt: string } {
  if (role !== "discovery.explorer") throw new Error(`Unsupported xper agent: ${role}`);
  return {
    name: role,
    systemPrompt:
      "You are discovery.explorer. Investigate the user's task and return a concise Discovery Brief with context, evidence, risks, and open questions. Use tools only to inspect the project; do not implement changes.",
  };
}

/** Runs one isolated Pi RPC session. Only the final assistant text becomes an artifact. */
export function runDiscovery(
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  options: {
    command?: string;
    args?: string[];
    timeoutMs?: number;
    systemPrompt: string;
    model?: string;
  },
): Promise<DelegateResult> {
  if (signal?.aborted) return Promise.resolve({ outcome: "cancelled" });
  const child = spawn(
    options.command ?? process.env.XPER_PI_COMMAND ?? "pi",
    options.args ?? [
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--tools",
      "read,bash",
      ...(options.model ? ["--model", options.model] : []),
      "--system-prompt",
      options.systemPrompt,
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    let outcome: DelegateOutcome | undefined;
    let brief = "";
    let buffer = "";
    let settled = false;
    let finished = false;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill();
      forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => {
      if (outcome) return;
      outcome = "timed_out";
      stop();
    }, timeoutMs);
    const abort = () => {
      if (outcome) return;
      outcome = "cancelled";
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const done = (result: DelegateResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.on("error", () => {
      outcome = "failed";
    });
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString("utf8");
      if (buffer.length > 1_000_000) {
        outcome = "failed";
        child.kill();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record.type === "agent_settled") settled = true;
          if (record.type === "message_end") {
            const message = record.message as
              | {
                  role?: string;
                  content?: Array<{ type?: string; text?: string }>;
                  errorMessage?: string;
                }
              | undefined;
            if (message?.role === "assistant") {
              if (message.errorMessage) outcome = "failed";
              const text = message.content
                ?.filter((item) => item.type === "text")
                .map((item) => item.text ?? "")
                .join("\n")
                .trim();
              if (text) brief = text;
            }
          }
          if (settled && child.stdin.writable) child.stdin.end();
        } catch {
          outcome = "failed";
          child.kill();
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("close", (code, terminationSignal) => {
      if (outcome) return done({ outcome });
      if (terminationSignal || code !== 0 || !settled || !brief.trim())
        return done({ outcome: "failed" });
      done({ outcome: "succeeded", brief });
    });
    child.stdin.on("error", () => {
      /* close determines the terminal outcome */
    });
    child.stdin.write(
      `${JSON.stringify({ id: "xper-discovery", type: "prompt", message: task })}\n`,
    );
  });
}
