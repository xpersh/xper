import { delegateKnowledge, type KnowledgeDependencies } from "../actions/delegate-knowledge.js";
import type { PiExtensionAPI } from "./types.js";
import type { XperSession } from "./session.js";

export function registerXperDelegate(
  pi: PiExtensionAPI,
  session: XperSession,
  execution: Pick<KnowledgeDependencies, "execute" | "saveBrief">,
): void {
  pi.registerTool({
    name: "xper_delegate",
    label: "Xper knowledge phase",
    description:
      "Execute the current knowledge assignment from its input artifacts and ask the core to evaluate its gate. Supports Discovery through Plan. Start a run with /xper first.",
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
      const result = await delegateKnowledge(
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
            text: `Knowledge attempt ${attemptId}: ${outcome}; phase ${phase}${result.reason ? `; ${result.reason}` : ""}${artifactPath ? `; artifact ${artifactPath}` : ""}${result.gate?.advanced === false ? `; ${result.gate.reason}` : ""}${result.gate?.ready ? "; execution plan ready" : ""}${result.gate?.humanArtifactId ? `; approve with /xper approve ${result.gate.humanArtifactId}` : ""}`,
          },
        ],
        details: { attemptId, outcome, phase, artifactId },
      };
    },
  });
}
