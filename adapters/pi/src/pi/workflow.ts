import { XperWorkflow } from "@xper/adapter-shared/workflow";
import type { WorkflowOptions } from "@xper/adapter-shared/workflow";
import type { RecorderClient } from "@xper/adapter-shared/bridge";

/** Preserve the Pi constructor while sharing the runtime and its workflow decisions. */
export class PiWorkflow extends XperWorkflow {
  constructor(
    recorder: Pick<RecorderClient, "appendEvents">,
    cwd: string,
    sessionId: string,
    options: Omit<WorkflowOptions, "adapterId"> = {},
  ) {
    super(recorder, cwd, sessionId, { ...options, adapterId: "pi" });
  }
}
