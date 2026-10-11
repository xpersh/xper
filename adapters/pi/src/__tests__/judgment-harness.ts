import { registerXperCommand } from "../pi/xper-command.js";
import { XperSession } from "../pi/session.js";
import type { XperWorkflow } from "@xper/adapter-shared/workflow";
import { fakePi } from "./extension-harness.js";
export {
  checkpoint,
  judged,
  reportFor,
  required,
} from "../../../shared/dist/__tests__/judgment-harness.js";
export function commands(workflow: XperWorkflow) {
  const ui = fakePi();
  const session = {
    workflow,
    lastRun: undefined as Awaited<ReturnType<XperWorkflow["getRunStatus"]>> | undefined,
    async refreshRun() {
      this.lastRun = await workflow.getRunStatus();
    },
    phaseSummary() {
      return XperSession.prototype.phaseSummary.call(this as unknown as XperSession);
    },
  };
  registerXperCommand(ui.pi, {
    ...session,
    configurationSummary: () => "Pi defaults",
  } as unknown as XperSession);
  return ui;
}
