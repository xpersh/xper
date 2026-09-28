import type { PiExtensionAPI } from "./types.js";
import { PROTOCOL_VERSION } from "../bridge/protocol.js";
import { ADAPTER_VERSION, type XperSession } from "./session.js";
import { listAvailableModels } from "../discovery/models.js";

const USAGE = "Usage: /xper [objective] | /xper start <objective> | /xper status | /xper advance";

export function registerXperCommand(pi: PiExtensionAPI, session: XperSession): void {
  pi.registerCommand("xper", {
    description: "Start, advance, or inspect the current xper run",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [first] = input.split(/\s+/);
      const action = ["status", "advance", "help"].includes(first ?? "") ? first : "start";
      let objective = first === "start" ? input.slice("start".length).trim() : input;
      const connection = session.connection;
      session.observation?.record("command.invoked", {
        command: "xper",
        recognized: true,
        bridgeConnected: connection !== undefined,
      });
      if (
        action === "help" ||
        ((action === "status" || action === "advance") && input !== action)
      ) {
        ctx.ui.notify(USAGE, "info");
        return;
      }
      if (action === "start" || action === "advance") {
        if (!connection) {
          ctx.ui.notify(`xper: ${session.error ?? "bridge offline"}`, "warning");
          return;
        }
        try {
          let message: string;
          if (action === "start") {
            if (!objective) {
              if (!ctx.hasUI) {
                ctx.ui.notify("Provide an objective: /xper <objective>", "info");
                return;
              }
              const answer = await ctx.ui.input(
                "Start xper workflow",
                "What would you like to achieve?",
              );
              if (answer === undefined) return;
              objective = answer.trim();
              if (!objective) {
                ctx.ui.notify("An objective is required to start the workflow.", "info");
                return;
              }
            }
            const routing = await connection.workflow.inspectProfile();
            if (routing && !routing.routes["discovery.explorer"]?.length)
              throw new Error("active profile has no Discovery route");
            const models = routing ? await listAvailableModels() : undefined;
            const result = await connection.workflow.startRun(objective, models);
            message = `${result.resumed ? "Resumed" : "Started"} workflow ${result.runId}; phase ${result.phase ?? "unknown"}.`;
            if (result.phase === "discovery") {
              message += " Ask Pi to delegate Discovery with xper_delegate.";
            }
          } else {
            const result = await connection.workflow.advanceRun();
            message = JSON.stringify(result);
          }
          await session.refreshRun();
          ctx.ui.notify(`xper: ${message}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `xper: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }
      const state = connection
        ? `connected (pid ${connection.client.process.pid ?? "?"}, bridge ${connection.handshake.bridgeVersion})`
        : `offline${session.error ? `: ${session.error}` : ""}`;
      const counts = session.observation?.summary();
      const observed = counts
        ? `; tools observed: started ${counts.started}, completed ${counts.completed}, failed ${counts.failed}, in flight ${counts.inFlight}, unpaired ${counts.unpaired}`
        : "";
      ctx.ui.notify(
        `xper adapter pi ${ADAPTER_VERSION}; protocol ${PROTOCOL_VERSION}; bridge ${state}${session.phaseSummary()}${observed}`,
        connection ? "info" : "warning",
      );
      void session.refreshRun().catch(() => {});
    },
  });
}
