import { registerXperCommand } from "../pi/xper-command.js";
import { XperSession } from "../pi/session.js";
import type { PiWorkflow } from "../workflow/controller.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import type { AdapterCheckpoint } from "../workflow/checkpoint/types.js";
import { fakePi } from "./extension-harness.js";
import type { JudgmentReport, Verdict } from "../workflow/judgment/contract.js";
import assert from "node:assert/strict";
import type { RoutingSnapshot } from "../bridge/xper-client.js";
import type { JudgmentAssignmentStarted } from "../workflow/types.js";
import {
  completeImplementation,
  completeVerification,
  sealTwoIncrementPlan,
  setup,
} from "./workflow-harness.js";
export function required<T>(value: T | null | undefined): T {
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

export function setVerdict(report: JudgmentReport, verdict: Verdict): void {
  report.output.verdict = verdict;
  if (verdict === "ACCEPT_WITH_DEBT")
    report.output.debts = [
      {
        id: "debt-1",
        description: "Replace temporary storage",
        owner: "Storage team",
        futureCondition: "Before multi-user release",
      },
      {
        id: "debt-2",
        description: "Measure large inputs",
        owner: "Runtime team",
        futureCondition: "Before raising the input limit",
      },
    ];
  if (verdict === "HUMAN_DECISION")
    report.output.humanDecision = {
      question: "Should the evaluated integration risk be accepted?",
      evidence: [report.evaluation.planArtifactId],
    };
}

export async function judged(verdict: Verdict = "ACCEPT", maxAttempts = 1, withDebt = false) {
  const h = await ready(null, maxAttempts);
  try {
    const started = await h.controller.startAssignment(undefined, "provider/judge");
    assert(started.workflow === "judgment" && started.artifactPath);
    const report = JSON.parse(reportFor(started)) as JudgmentReport;
    if (withDebt) setVerdict(report, "ACCEPT_WITH_DEBT");
    setVerdict(report, verdict);
    if (verdict === "REJECT") {
      const criterion = report.output.criteria[0];
      assert(criterion);
      criterion.outcome = "uncertain";
      report.output.criticisms = [
        { reason: "Integration risk remains unresolved", evidence: criterion.evidence },
      ];
    }
    const content = JSON.stringify(report);
    h.artifacts.set(started.artifactPath, { content, digest: content });
    const finished = await h.controller.finishAttempt({
      attemptId: started.attemptId,
      outcome: "succeeded",
      artifactPath: started.artifactPath,
    });
    assert(!finished.replayed && finished.artifactId);
    return {
      ...h,
      reportId: finished.artifactId,
      reportPath: started.artifactPath,
      revision: started.evaluation.evaluatedCommit,
      started,
      report,
    };
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}
export async function checkpoint(h: Awaited<ReturnType<typeof ready>>): Promise<AdapterCheckpoint> {
  const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
  await journal.load();
  const state = decodeAdapterCheckpoint(journal.state);
  assert(state);
  return state;
}

export function commands(workflow: PiWorkflow) {
  const ui = fakePi();
  const session = {
    workflow,
    lastRun: undefined as Awaited<ReturnType<PiWorkflow["getRunStatus"]>> | undefined,
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
