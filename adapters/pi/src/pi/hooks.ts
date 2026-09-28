import type { PiExtensionAPI } from "./types.js";
import type { XperSession } from "./session.js";

export function registerPiHooks(pi: PiExtensionAPI, session: XperSession): void {
  pi.on("session_start", async (event, ctx) => session.start(ctx, event.reason));
  pi.on("session_shutdown", async (event, ctx) => session.stop(ctx, event.reason));
  pi.on("session_compact_failed", (_event, ctx) => session.forwardError(ctx, "session_compact"));
  pi.on("tool_execution_start", (event) => {
    session.observation?.toolStarted(event.toolName, event.toolCallId);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    // This is an observation only. Delegation outcomes and cancellation are not inferred here.
    session.observation?.toolEnded(event);
    if (event.isError) session.forwardError(ctx, `tool:${event.toolName}`, event.toolCallId);
  });
}
