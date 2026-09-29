import { spawn } from "node:child_process";
import type { KnowledgeExecutionResult } from "../actions/delegate-knowledge.js";
import type { AttemptOutcome, ModelUsage } from "../workflow/types.js";

export type DelegateOutcome = AttemptOutcome;
export type DelegateResult = KnowledgeExecutionResult;

/** Keep review roles observational while allowing the Implementer to change its checkout. */
export function toolsForRole(role: string): string[] {
  return role === "implementation.driver" ? ["read", "bash", "edit", "write"] : ["read", "bash"];
}

/** Translate a neutral role to the local execution instructions. */
export function resolveAgent(role: string): { name: string; systemPrompt: string } {
  const outputs: Record<string, string> = {
    "define.product":
      '{"kind":"definition_contract","goal":"...","scope":["..."],"exclusions":[],"criteria":[{"id":"c1","behavior":"...","example":"..."}]}',
    "design.designer":
      '{"kind":"design_decisions","approach":"...","interfaces":["..."],"alternatives":["..."],"risks":[],"feasible":true}',
    "breakdown.slicer":
      '{"kind":"story_map","stories":[{"id":"s1","value":"...","criteria":["c1"],"verification":["..."],"independentlyVerifiable":true,"dependencies":[]}]}',
    "plan.planner":
      '{"kind":"execution_plan","assignments":[{"id":"a1","incrementId":"s1","role":"implementation.driver","dependencies":[],"workspace":"s1","resources":[],"maxAttempts":1,"maxTimeMs":60000,"maxCostMicros":0},{"id":"a2","incrementId":"s1","role":"verify.verifier","dependencies":["a1"],"workspace":"s1","resources":[],"maxAttempts":1,"maxTimeMs":60000,"maxCostMicros":0}]}',
  };
  if (role === "discovery.explorer")
    return {
      name: role,
      systemPrompt:
        "You are discovery.explorer. Investigate the user's task and return a concise Discovery Brief with context, evidence, risks, and open questions. Use tools only to inspect the project; do not implement changes.",
    };
  if (role === "implementation.driver")
    return {
      name: role,
      systemPrompt:
        "You are implementation.driver. Work only in the supplied existing checkout. Read its AGENTS.md instructions and accepted artifacts, implement the assigned increment with tests, and create a local commit containing only that work. Never clone, create a worktree, reset unrelated work, or push. Leave the checkout clean. Your final response must be only the requested JSON report; do not invent test exit statuses because the host reruns the commands.",
    };
  if (role === "verify.verifier")
    return {
      name: role,
      systemPrompt:
        "You are verify.verifier. Independently review the exact supplied implementation revision for behavior, regressions, unrequested scope, and unnecessary complexity. Read the accepted artifacts, implementation result, source, diff, and test logs. You must not edit, write, commit, reset, clean, or repair the checkout. Your final response must be only the requested JSON report; do not invent test exit statuses because the host runs the commands.",
    };
  const output = outputs[role];
  if (!output) throw new Error(`Unsupported xper agent: ${role}`);
  return {
    name: role,
    systemPrompt: `You are ${role}. Inspect the supplied input artifacts; they are the phase contract. Do not implement code or create workspaces. Return only JSON: {"schemaVersion":1,"inputs":[all supplied artifact IDs],"output":${output}}. Use meaningful evidence instead of placeholders. If uncertainty originates earlier, return output {"kind":"feedback","reason":"ambiguous_criteria"|"infeasible_design"|"missing_context"|"oversized_story","evidence":"concrete explanation"}. Plans need exactly one implementer (implementation.driver) and one verifier (verify.verifier) per increment; verification follows implementation and all increment prerequisites. Serialize assignments sharing workspaces or resources. Include all story dependencies. These are proposed assignments, never execute them.`,
  };
}

/** Runs one isolated Pi RPC session. Only the final assistant text becomes an artifact. */
export function runKnowledge(
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
