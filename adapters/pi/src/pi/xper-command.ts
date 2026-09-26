import type { PiExtensionAPI } from "./types.js";
import { PROTOCOL_VERSION } from "../bridge/protocol.js";
import { ADAPTER_VERSION, type XperSession } from "./session.js";

export function registerXperCommand(pi: PiExtensionAPI, session: XperSession): void {
  pi.registerCommand("xper", {
    description: "Start, advance, or inspect the current xper run",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      const connection = session.connection;
      session.observation?.record("command.invoked", {
        command: "xper",
        recognized: ["status", "start", "advance"].includes(action ?? ""),
        bridgeConnected: connection !== undefined,
      });
      if (action === "start" || action === "advance") {
        if (!connection) {
          ctx.ui.notify(`xper: ${session.error ?? "bridge offline"}`, "warning");
          return;
        }
        try {
          const result = await connection.client.request(
            action === "start" ? "run.start" : "run.advance",
            action === "start" ? { objective: rest.join(" ") } : {},
          );
          await session.refreshRun();
          ctx.ui.notify(`xper: ${JSON.stringify(result)}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `xper: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /xper start <objective> | /xper status | /xper advance", "info");
        return;
      }
      const state = connection
        ? `connected (pid ${connection.client.process.pid ?? "?"}, bridge ${connection.handshake.bridgeVersion})`
        : `offline${session.error ? `: ${session.error}` : ""}`;
      const counts = session.observation?.summary();
      const observed = counts
        ? `; subagent observed: started ${counts.started}, reported done ${counts.reportedDone}, reported error ${counts.reportedError}, unclassified ${counts.unclassified}, in flight ${counts.inFlight}, mismatches ${counts.mismatches}, unpaired ${counts.unpaired}`
        : "";
      ctx.ui.notify(
        `xper adapter pi ${ADAPTER_VERSION}; protocol ${PROTOCOL_VERSION}; bridge ${state}${session.phaseSummary()}${observed}`,
        connection ? "info" : "warning",
      );
      void session.refreshRun().catch(() => {});
    },
  });
}
