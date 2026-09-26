import { delegateDiscovery, type DiscoveryDependencies } from "../actions/delegate-discovery.js";
import type { PiExtensionAPI } from "./types.js";
import type { XperSession } from "./session.js";

export function registerXperDelegate(
  pi: PiExtensionAPI,
  session: XperSession,
  execution: Pick<DiscoveryDependencies, "execute" | "saveBrief">,
): void {
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
      const result = await delegateDiscovery(
        {
          ...params,
          cwd: ctx.cwd,
          signal,
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        },
        {
          ...execution,
          workflow: connection.workflow,
          observe: ({ type, ...fields }) =>
            session.observation?.record(type, { toolCallId, ...fields }),
        },
      );
      const { attemptId, outcome, phase, artifactPath, artifactId } = result;
      await session.refreshRun();
      return {
        content: [
          {
            type: "text",
            text: `Discovery attempt ${attemptId}: ${outcome}; phase ${phase}${artifactPath ? `; brief ${artifactPath}` : ""}`,
          },
        ],
        details: { attemptId, outcome, phase, artifactId },
      };
    },
  });
}
