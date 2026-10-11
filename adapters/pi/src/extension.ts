import { resolveAgent } from "@xper/adapter-shared";
import type { BridgeOptions } from "@xper/adapter-shared/bridge";
import { saveArtifact } from "@xper/adapter-shared/execution";
import { runPiChild } from "./execution/child.js";
import { runImplementation } from "@xper/adapter-shared/execution";
import { runJudgment } from "@xper/adapter-shared/execution";
import { piModelOptions } from "./execution/models.js";
import { toolsForRole } from "./execution/roles.js";
import { runVerification } from "@xper/adapter-shared/execution";
import { registerPiHooks } from "./pi/hooks.js";
import { XperSession } from "./pi/session.js";
import type { PiExtensionAPI } from "./pi/types.js";
import { registerXperCommand } from "./pi/xper-command.js";
import { registerXperDelegate } from "./pi/xper-delegate.js";
import { readEvidence } from "@xper/adapter-shared/execution";

const registrationChannel = "xper:extension:claim:v1";

/** Register a Pi extension. Process creation is deferred until session_start. */
export function createXperExtension(
  pi: PiExtensionAPI,
  options: BridgeOptions & { observationsFile?: string } = {},
): void {
  let registered = false;
  // Pi dispatches event handlers synchronously and removes their subscriptions on reload.
  pi.events?.emit(registrationChannel, () => {
    registered = true;
  });
  if (registered) return;
  const release = pi.events?.on(registrationChannel, (claim) => {
    if (typeof claim === "function") claim();
  });
  try {
    registerExtension(pi, options);
  } catch (error) {
    release?.();
    throw error;
  }
}

function registerExtension(
  pi: PiExtensionAPI,
  options: BridgeOptions & { observationsFile?: string },
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
        runPiChild(message, cwd, signal, {
          systemPrompt: resolveAgent(role).systemPrompt,
          timeoutMs: childTimeoutMs,
          tools: toolsForRole(role),
          ...modelOptions,
        });
      if (execution.workflow === "judgment")
        return runJudgment(execution, {
          runChild,
          readEvidence: (path) => readEvidence(cwd, path),
        });
      if (execution.workflow === "implementation")
        return runImplementation(execution, { runChild });
      if (execution.workflow === "verification") return runVerification(execution, { runChild });
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
