import assert from "node:assert/strict";
import type { RoutingSnapshot } from "../bridge/xper-client.js";
import type { JudgmentAssignmentStarted } from "../workflow/types.js";
import {
  completeImplementation,
  completeVerification,
  sealTwoIncrementPlan,
  setup,
} from "./workflow-harness.js";
function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined);
  return value;
}
export async function ready(routing: RoutingSnapshot | null = null, maxAttempts = 1) {
  const h = await setup({}, undefined, routing);
  try {
    await sealTwoIncrementPlan(h, true, maxAttempts);
    for (const digit of ["2", "3"]) {
      await completeImplementation(h, digit.repeat(40));
      h.setWorkspace({ root: h.cwd, head: digit.repeat(40), clean: true, status: "" });
      await completeVerification(h, "verified");
      assert.equal((await h.controller.getRunStatus()).judgment, undefined);
    }
    return h;
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}
export function reportFor(started: JudgmentAssignmentStarted) {
  return JSON.stringify({
    schemaVersion: 1,
    evaluation: started.evaluation,
    output: {
      kind: "judgment_verdict",
      verdict: "ACCEPT",
      reason: "Verified evidence supports acceptance",
      criticisms: [],
      assignmentId: started.assignmentId,
      criteria: started.evaluation.criterionIds.map((criterionId) => ({
        criterionId,
        outcome: "passed",
        reason: "Independent verification supports this behavior",
        evidence: [
          required(
            started.evaluation.artifacts.find(
              (artifact) => artifact.kind === "verification_result",
            ),
          ).artifact_id,
        ],
      })),
    },
  });
}
