import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgent, runDiscovery } from "../discovery/delegate.js";
import type { PiExtensionAPI } from "./types.js";
import type { XperSession } from "./session.js";

export function registerXperDelegate(pi: PiExtensionAPI, session: XperSession): void {
  pi.registerTool({
    name: "xper_delegate",
    label: "Xper Discovery explorer",
    description:
      "Delegate the current Discovery task and record a Discovery Brief before entering Define. Start a run with /xper start first.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 },
        assignmentId: {
          type: "string",
          description: "Retry a pending assignment after interruption",
        },
      },
      required: ["task"],
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const connection = session.connection;
      if (!connection) throw new Error(session.error ?? "xper bridge offline");
      if (!params.task?.trim()) throw new Error("Discovery task is required");
      const timeoutSeconds = params.timeoutSeconds ?? 120;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
        throw new Error("timeoutSeconds must be between 1 and 600");
      }
      const started = await connection.client.request(
        "assignment.start",
        params.assignmentId ? { assignmentId: params.assignmentId } : {},
      );
      const attemptId = started.attemptId as string;
      session.observation?.record("attempt.correlated", { toolCallId, attemptId });
      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out" = "failed";
      let relative: string | undefined;
      try {
        const agent = resolveAgent(started.role as string);
        const result = await runDiscovery(params.task, ctx.cwd, signal, {
          timeoutMs: timeoutSeconds * 1_000,
          systemPrompt: agent.systemPrompt,
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        });
        outcome = result.outcome;
        if (outcome === "succeeded" && result.brief) {
          relative = `.xper/artifacts/discovery-brief-${attemptId}.md`;
          await mkdir(join(ctx.cwd, ".xper", "artifacts"), { recursive: true });
          await writeFile(join(ctx.cwd, relative), result.brief, { flag: "wx" });
        }
      } catch {
        outcome = signal.aborted ? "cancelled" : "failed";
      }
      const settled = await connection.client.request("attempt.finish", {
        attemptId,
        outcome,
        ...(relative && outcome === "succeeded" ? { artifactPath: relative } : {}),
      });
      session.observation?.record("attempt.finished", { toolCallId, attemptId, outcome });
      let phase = "discovery";
      if (outcome === "succeeded") {
        const advanced = await connection.client.request("run.advance");
        if (advanced.advanced) phase = "define";
      }
      await session.refreshRun();
      return {
        content: [
          {
            type: "text",
            text: `Discovery attempt ${attemptId}: ${outcome}; phase ${phase}${relative ? `; brief ${relative}` : ""}`,
          },
        ],
        details: { attemptId, outcome, phase, artifactId: settled.artifactId ?? null },
      };
    },
  });
}
