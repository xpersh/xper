import type { PiExtensionAPI } from "./types.js";
import { PROTOCOL_VERSION } from "../bridge/protocol.js";
import { ADAPTER_VERSION, type XperSession } from "./session.js";

const USAGE =
  "Usage: /xper [objective] | /xper start <objective> | /xper status | /xper advance | /xper approve <artifactId> [<commit>] | /xper resume <commit>";

export function registerXperCommand(pi: PiExtensionAPI, session: XperSession): void {
  pi.registerCommand("xper", {
    description: "Start, advance, or inspect the current xper run",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [first] = input.split(/\s+/);
      const action = ["status", "advance", "approve", "resume", "help"].includes(first ?? "")
        ? first
        : "start";
      let objective = first === "start" ? input.slice("start".length).trim() : input;
      const connection = session.connection;
      const workflow = session.workflow;
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
      if (
        action === "start" ||
        action === "advance" ||
        action === "approve" ||
        action === "resume"
      ) {
        if (!workflow) {
          ctx.ui.notify(`xper: local workflow is not initialized`, "warning");
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
            const prepared = session.configurationSummary();
            const result = await workflow.startRun(objective);
            message = `${result.resumed ? "Resumed" : "Started"} workflow ${result.runId}; phase ${result.phase ?? "unknown"}.`;
            if (result.phase === "discovery") {
              message += " Ask Pi to delegate Discovery with xper_delegate.";
            }
            if (!result.resumed) message += ` Configuration: ${prepared}.`;
          } else if (action === "resume") {
            const revision = input.slice("resume".length).trim();
            if (!revision || /\s/.test(revision))
              throw new Error("Provide the clean checkout commit to resume delivery");
            const result = await workflow.resumeDelivery(revision);
            message = JSON.stringify(result);
          } else {
            const args = action === "approve" ? input.split(/\s+/).slice(1) : [];
            if (action === "approve" && (args.length < 1 || args.length > 2))
              throw new Error(
                "Provide the human gate artifact ID, or the Judge report ID and full evaluated commit",
              );
            const [artifactId, revision] = args;
            if (artifactId && revision) {
              const result = await workflow.applyJudgment(artifactId, revision);
              const unresolved =
                result.status === "reopened"
                  ? (await workflow.getRunStatus()).unresolvedReason
                  : undefined;
              message =
                result.status === "reopened"
                  ? `Run ${result.runId} reopened: ${result.phase}; report ${result.reportId}; evaluated ${result.evaluatedCommit}${result.replayed ? "; existing decision" : ""}. ${unresolved ? `Unresolved: ${unresolved}.` : "Use xper_delegate for the next assignment."}`
                  : `Run ${result.runId} closed: ${result.status}; report ${result.reportId}; evaluated ${result.evaluatedCommit}${result.replayed ? "; existing decision" : ""}. [Run summary](${result.summary.path})`;
            } else {
              message = JSON.stringify(await workflow.advanceRun(artifactId));
            }
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
      await session.refreshRun();
      const state =
        connection && !session.error
          ? `connected (pid ${connection.client.process.pid ?? "?"}, bridge ${connection.handshake.bridgeVersion})`
          : `offline${session.error ? `: ${session.error}` : ""}`;
      const counts = session.observation?.summary();
      const observed = counts
        ? `; tools observed: started ${counts.started}, completed ${counts.completed}, failed ${counts.failed}, in flight ${counts.inFlight}, unpaired ${counts.unpaired}`
        : "";
      ctx.ui.notify(
        `xper adapter pi ${ADAPTER_VERSION}; protocol ${PROTOCOL_VERSION}; bridge ${state}${session.phaseSummary()}; prepared configuration: ${session.configurationSummary()}${observed}`,
        connection ? "info" : "warning",
      );
    },
  });
}
