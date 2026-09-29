import type { BridgeOptions } from "./bridge/client.js";
import { saveArtifact } from "./knowledge/artifacts.js";
import { runImplementation } from "./implementation/execution.js";
import { resolveAgent, runKnowledge } from "./knowledge/delegate.js";
import { piModelOptions } from "./knowledge/models.js";
import type { PiExtensionAPI } from "./pi/types.js";
import { registerPiHooks } from "./pi/hooks.js";
import { XperSession } from "./pi/session.js";
import { registerXperCommand } from "./pi/xper-command.js";
import { registerXperDelegate } from "./pi/xper-delegate.js";

/** Register a Pi extension. Process creation is deferred until session_start. */
export function createXperExtension(
  pi: PiExtensionAPI,
  options: BridgeOptions & { observationsFile?: string } = {},
): void {
  const session = new XperSession(options);
  registerXperCommand(pi, session);
  registerXperDelegate(pi, session, {
    execute: (execution) => {
      const {
        task,
        cwd,
        signal,
        role,
        timeoutMs,
        model,
        selection,
        inputArtifacts,
        artifactKind,
        budget,
      } = execution;
      const modelOptions = selection ? piModelOptions(selection) : model ? { model } : {};
      const runChild = (message: string, childTimeoutMs: number) =>
        runKnowledge(message, cwd, signal, {
          systemPrompt: resolveAgent(role).systemPrompt,
          timeoutMs: childTimeoutMs,
          ...(role === "implementation.driver" ? { tools: ["read", "bash", "edit", "write"] } : {}),
          ...modelOptions,
        });
      if (execution.workflow === "implementation")
        return runImplementation(execution, { runChild });
      return runChild(
        inputArtifacts?.length
          ? `${task}\n\nInput artifacts (read these files):\n${JSON.stringify(inputArtifacts)}\nRequired output: ${artifactKind}\nRemaining budget: ${JSON.stringify(budget)}`
          : task,
        timeoutMs,
      );
    },
    saveBrief: saveArtifact,
  });
  registerPiHooks(pi, session);
}

export default createXperExtension;
