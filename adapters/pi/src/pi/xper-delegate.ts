import { delegateWorkflow } from "../actions/delegate-workflow.js";
import type { DelegationDependencies } from "../actions/delegation.js";
import type { XperSession } from "./session.js";
import type { PiExtensionAPI } from "./types.js";

export function registerXperDelegate(
  pi: PiExtensionAPI,
  session: XperSession,
  execution: Pick<DelegationDependencies, "execute" | "saveBrief">,
): void {
  pi.registerTool({
    name: "xper_delegate",
    label: "Xper assignment",
    description:
      "Execute the current xper assignment from sealed artifacts and evaluate its local gate. Supports Knowledge and the first Implementer/Verifier delivery loop. Start a run with /xper first.",
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
      const workflow = session.workflow;
      if (!workflow) throw new Error("local xper workflow is not initialized");
      const result = await delegateWorkflow(
        {
          ...params,
          cwd: ctx.cwd,
          signal,
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        },
        {
          ...execution,
          workflow,
          observe: ({ type, ...fields }) =>
            session.observation?.record(type, { toolCallId, ...fields }),
        },
      );
      const { attemptId, outcome, phase, incrementId, artifactPath, artifactId } = result;
      await session.refreshRun();
      return {
        content: [
          {
            type: "text",
            text: `Xper attempt ${attemptId}: ${outcome}; phase ${phase}${result.reason ? `; ${result.reason}` : ""}${artifactPath ? `; artifact ${artifactPath}` : ""}${result.gate?.advanced === false ? `; ${result.gate.reason}` : ""}${result.gate?.ready ? "; execution plan ready" : ""}${result.gate?.resumeRequired ? "; resume revised delivery with /xper resume <commit>" : ""}${result.gate?.humanArtifactId ? `; approve with /xper approve ${result.gate.humanArtifactId}` : ""}`,
          },
        ],
        details: { attemptId, outcome, phase, incrementId, artifactId },
      };
    },
  });
}
