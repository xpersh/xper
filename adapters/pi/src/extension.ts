import type { BridgeOptions } from "./bridge/client.js";
import { saveDiscoveryBrief } from "./discovery/artifacts.js";
import { resolveAgent, runDiscovery } from "./discovery/delegate.js";
import type { PiExtensionAPI } from "./pi/types.js";
import { registerPiHooks } from "./pi/hooks.js";
import { XperSession } from "./pi/session.js";
import { registerXperCommand } from "./pi/xper-command.js";
import { registerXperDelegate } from "./pi/xper-delegate.js";

export { isPiToolError } from "./pi/observations.js";

/** Register a Pi extension. Process creation is deferred until session_start. */
export function createXperExtension(
  pi: PiExtensionAPI,
  options: BridgeOptions & { observationsFile?: string } = {},
): void {
  const session = new XperSession(options);
  registerXperCommand(pi, session);
  registerXperDelegate(pi, session, {
    execute: ({ task, cwd, signal, role, timeoutMs, model }) =>
      runDiscovery(task, cwd, signal, {
        systemPrompt: resolveAgent(role).systemPrompt,
        timeoutMs,
        ...(model ? { model } : {}),
      }),
    saveBrief: saveDiscoveryBrief,
  });
  registerPiHooks(pi, session);
}

export default createXperExtension;
