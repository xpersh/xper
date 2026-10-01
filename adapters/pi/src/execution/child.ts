import { spawn } from "node:child_process";
import type { ExecutionResult } from "../actions/execution.js";
import type { AttemptOutcome, ModelUsage } from "../workflow/types.js";

export type DelegateOutcome = AttemptOutcome;

export type DelegateResult = ExecutionResult;

export function runPiChild(
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  options: {
    command?: string;
    args?: string[];
    timeoutMs?: number;
    systemPrompt: string;
    model?: string;
    thinking?: string;
    tools?: string[];
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
      (options.tools ?? ["read", "bash"]).join(","),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.thinking ? ["--thinking", options.thinking] : []),
      "--system-prompt",
      options.systemPrompt,
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    let outcome: Exclude<DelegateOutcome, "succeeded"> | undefined;
    let brief = "";
    let buffer = "";
    let settled = false;
    let finished = false;
    const usage: ModelUsage[] = [];
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
      resolve(usage.length ? { ...result, usage } : result);
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
                  provider?: string;
                  model?: string;
                  responseModel?: string;
                  usage?: {
                    input?: unknown;
                    output?: unknown;
                    cacheRead?: unknown;
                    cacheWrite?: unknown;
                    cost?: { total?: unknown };
                  };
                }
              | undefined;
            if (message?.role === "assistant") {
              const count = (value: unknown): number | null =>
                typeof value === "number" && Number.isSafeInteger(value) && value >= 0
                  ? value
                  : null;
              const total = message.usage?.cost?.total;
              const reportedModel = message.responseModel ?? message.model;
              const costMicros =
                typeof total === "number" && Number.isFinite(total) && total >= 0
                  ? count(Math.round(total * 1_000_000))
                  : null;
              // Pi computes these costs from its model catalog, not a billing receipt.
              // Missing usage still produces an unknown report, not a zero total.
              usage.push({
                inputTokens: count(message.usage?.input),
                outputTokens: count(message.usage?.output),
                cacheReadTokens: count(message.usage?.cacheRead),
                cacheWriteTokens: count(message.usage?.cacheWrite),
                costMicros,
                ...(costMicros === null ? {} : { costSource: "pi_estimate" as const }),
                ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
                ...(typeof reportedModel === "string" ? { model: reportedModel } : {}),
              });
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
