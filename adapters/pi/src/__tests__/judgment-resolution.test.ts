import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PiWorkflow } from "../workflow/controller.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import { parseJudgmentReport } from "../workflow/judgment/contract.js";
import { resolutionPath } from "../workflow/judgment/resolution.js";
import type { JudgmentDecision, JudgmentResolutionInput } from "../workflow/types.js";
import { checkpoint, commands, judged, reportFor, required } from "./judgment-harness.js";
import { completeImplementation, completeVerification } from "./workflow-harness.js";

function input(
  h: Awaited<ReturnType<typeof judged>>,
  decision: JudgmentDecision,
): JudgmentResolutionInput {
  return {
    decision,
    reason: "Explicitly evaluated by the person",
    debts: h.report.output.debts ?? [],
    ...(h.report.output.humanDecision ? { humanDecision: h.report.output.humanDecision } : {}),
  };
}

test("HUMAN_DECISION with debt requires whole-list acceptance and preflight context is detached", async () => {
  const h = await judged("HUMAN_DECISION", 1, true);
  try {
    const approval = await h.controller.prepareJudgmentApproval(h.reportId, h.revision);
    assert(!("applied" in approval));
    approval.evaluation.evaluatedCommit = "f".repeat(40);
    approval.debts?.splice(0);
    const ui = commands(h.controller);
    ui.answers.push("ACCEPT_WITH_DEBT", "Accept all obligations", "CONFIRM");
    assert.match(await ui.command(`approve ${h.reportId} ${h.revision}`), /accepted_with_debt/);
    const resolution = (await h.controller.getRunStatus()).humanResolution;
    assert.equal(resolution?.debts.length, 2);
    assert.deepEqual(resolution?.completedByHuman, []);
    assert.equal(resolution?.evaluatedCommit, h.revision);
  } finally {
    await h.cleanup();
  }
});

test("the human dialog accepts all debt with explicit classification, evidence and immutable replay", async () => {
  const h = await judged("ACCEPT_WITH_DEBT");
  try {
    const ui = commands(h.controller);
    const command = `approve ${h.reportId} ${h.revision}`;
    assert.match(await ui.status(), /apply with \/xper approve/);
    h.advanceTime((await checkpoint(h)).knowledge.policy.maxTimeMs);
    ui.answers.push("ACCEPT_WITH_DEBT", "Accept the listed obligations", "CONFIRM");
    assert.match(await ui.command(command), /closed: accepted_with_debt/);
    assert(ui.messages.some((message) => message.includes("Before multi-user release")));
    const state = await checkpoint(h);
    assert.equal(state.version, 9);
    assert.equal(state.judgment?.report?.verdict, "ACCEPT_WITH_DEBT");
    assert.deepEqual(state.closure?.resolution?.acceptedDebtIds, ["debt-1", "debt-2"]);
    assert(!JSON.stringify(state.closure?.resolution).includes("Replace temporary storage"));
    assert.match(await ui.status(), /Storage team.*Before multi-user release/);
    assert(state.closure);
    const summary = await readFile(join(h.cwd, state.closure.summary.path), "utf8");
    assert.match(summary, /accepted_with_debt/);
    assert.match(summary, /Replace temporary storage.*Storage team.*Before multi-user release/);
    await h.controller.waitForRecording();
    const accepted = h.recorder.events.filter((event) => event.type === "increment.accepted");
    assert.equal(accepted.length, 2);
    assert(
      accepted.every(
        (event) => event.data.verdict === "ACCEPT_WITH_DEBT" && event.data.resolutionArtifactId,
      ),
    );
    assert.equal(h.recorder.events.filter((event) => event.type === "judgment.resolved").length, 1);
    const restored = await h.restore();
    h.setWorkspace({ root: h.cwd, head: "f".repeat(40), clean: false, status: "dirty" });
    const secondUI = commands(restored);
    assert.match(await secondUI.command(command), /existing decision/);
    assert.equal(secondUI.prompts.length, 0);
    await assert.rejects(
      restored.applyJudgment(h.reportId, h.revision, input(h, "REJECT")),
      /conflicting/,
    );
    const corrupted = structuredClone(state);
    assert(corrupted.closure?.resolution);
    corrupted.closure.resolution.acceptedDebtIds = [];
    assert.throws(() => decodeAdapterCheckpoint(corrupted), /resolution/);
  } finally {
    await h.cleanup();
  }
});

test("human choices reuse every closure and feedback destination and pass the answer to subsequent work", async () => {
  for (const decision of [
    "ACCEPT",
    "REJECT",
    "REWORK_IMPLEMENTATION",
    "REVISIT_DESIGN",
    "REDEFINE",
  ] as const) {
    const h = await judged("HUMAN_DECISION", 3);
    try {
      const ui = commands(h.controller);
      ui.answers.push(decision, `Human explanation for ${decision}`, "CONFIRM");
      await ui.command(`approve ${h.reportId} ${h.revision}`);
      const status = await h.controller.getRunStatus();
      assert.equal(status.humanResolution?.decision, decision);
      assert.deepEqual(status.humanResolution?.humanDecision, h.report.output.humanDecision);
      if (decision === "ACCEPT" || decision === "REJECT") {
        assert.equal(status.closure?.status, decision === "ACCEPT" ? "accepted" : "rejected");
        assert.equal(status.closure.recommendation, "HUMAN_DECISION");
      } else {
        assert.equal(status.feedback?.verdict, decision);
        assert.equal(status.feedback.recommendation, "HUMAN_DECISION");
        const restored = await h.restore();
        if (decision === "REWORK_IMPLEMENTATION") {
          for (const digit of ["4", "5"]) {
            const produced = await completeImplementation(
              h,
              digit.repeat(40),
              "provider/model",
              restored,
            );
            assert(
              produced.assignment.inputArtifacts?.some(
                (artifact) => artifact.kind === "judgment_resolution",
              ),
            );
            h.setWorkspace({ root: h.cwd, head: digit.repeat(40), clean: true, status: "" });
            await completeVerification(h, "verified", "provider/model", restored);
          }
          const judge = await restored.startAssignment(undefined, "provider/judge");
          assert(judge.workflow === "judgment" && judge.artifactPath);
          assert(
            judge.evaluation.artifacts.some((artifact) => artifact.kind === "judgment_resolution"),
          );
          const content = reportFor(judge);
          h.artifacts.set(judge.artifactPath, { content, digest: content });
          const finished = await restored.finishAttempt({
            attemptId: judge.attemptId,
            outcome: "succeeded",
            artifactPath: judge.artifactPath,
          });
          assert(!finished.replayed && finished.artifactId);
          await restored.applyJudgment(finished.artifactId, judge.evaluation.evaluatedCommit);
        } else {
          const next = await restored.startAssignment();
          assert.equal(next.phase, decision === "REDEFINE" ? "define" : "design");
          assert(next.inputArtifacts?.some((artifact) => artifact.artifact_id === h.reportId));
          assert(next.inputArtifacts?.some((artifact) => artifact.kind === "judgment_resolution"));
        }
        assert.equal((await restored.applyJudgment(h.reportId, h.revision)).replayed, true);
      }
      assert.deepEqual(decodeAdapterCheckpoint(await checkpoint(h)), await checkpoint(h));
    } finally {
      await h.cleanup();
    }
  }
});

test("debt recommendations also permit explicit rejection or feedback without acceptance facts", async () => {
  for (const decision of [
    "REJECT",
    "REWORK_IMPLEMENTATION",
    "REVISIT_DESIGN",
    "REDEFINE",
  ] as const) {
    const h = await judged("ACCEPT_WITH_DEBT", 3);
    try {
      await h.controller.applyJudgment(h.reportId, h.revision, input(h, decision));
      const restored = await h.restore();
      assert.equal((await restored.getRunStatus()).humanResolution?.decision, decision);
      assert(!h.recorder.events.some((event) => event.type === "increment.accepted"));
    } finally {
      await h.cleanup();
    }
  }
});

test("cancellation, incomplete input, absent UI and invalid resolutions preserve the pending report", async () => {
  const h = await judged("ACCEPT_WITH_DEBT");
  try {
    const command = `approve ${h.reportId} ${h.revision}`;
    for (const answers of [
      [],
      ["ACCEPT_WITH_DEBT"],
      ["ACCEPT_WITH_DEBT", "reason"],
      ["ACCEPT_WITH_DEBT", "reason", "no"],
      ["ACCEPT"],
    ]) {
      const ui = commands(h.controller);
      ui.answers.push(...answers);
      assert.match(await ui.command(command), /remains pending/);
    }
    const ui = commands(h.controller);
    ui.ctx.hasUI = false;
    assert.match(await ui.command(command), /interactive Pi/);
    assert.equal(ui.prompts.length, 0);
    for (const resolution of [
      input(h, "ACCEPT"),
      { ...input(h, "ACCEPT_WITH_DEBT"), debts: [] },
      { ...input(h, "ACCEPT_WITH_DEBT"), reason: " " },
      { ...input(h, "ACCEPT_WITH_DEBT"), debts: [required(required(h.report.output.debts)[0])] },
      { ...input(h, "REJECT"), humanDecision: { question: "Question", evidence: ["unknown"] } },
    ])
      await assert.rejects(h.controller.applyJudgment(h.reportId, h.revision, resolution));
    assert.equal((await checkpoint(h)).closure, null);
    assert(!h.artifacts.has(resolutionPath(h.reportId)));
    await assert.rejects(
      h.controller.startAssignment(undefined, "provider/model"),
      /already recorded/,
    );
  } finally {
    await h.cleanup();
  }
});

test("a changed checkout or frozen evidence during the dialog invalidates the confirmation", async () => {
  for (const change of ["checkout", "report", "input"] as const) {
    const h = await judged("HUMAN_DECISION");
    try {
      const ui = commands(h.controller);
      const prompt = ui.ctx.ui.input;
      ui.ctx.ui.input = async (title) => {
        const answer = await prompt(title);
        if (title.startsWith("Type CONFIRM")) {
          if (change === "checkout")
            h.setWorkspace({ root: h.cwd, head: "f".repeat(40), clean: true, status: "" });
          else {
            const path =
              change === "report" ? h.reportPath : required(h.report.evaluation.artifacts[0]).path;
            h.artifacts.set(path, { content: "changed", digest: "changed" });
          }
        }
        return answer;
      };
      ui.answers.push("ACCEPT", "human answer", "CONFIRM");
      assert.match(
        await ui.command(`approve ${h.reportId} ${h.revision}`),
        /changed|evaluated revision/,
      );
      assert.equal((await checkpoint(h)).closure, null);
      assert(!h.artifacts.has(resolutionPath(h.reportId)));
    } finally {
      await h.cleanup();
    }
  }
});

test("legacy pending reports migrate and collect missing details without rewriting the report", async () => {
  for (const verdict of ["ACCEPT_WITH_DEBT", "HUMAN_DECISION"] as const) {
    const h = await judged(verdict);
    try {
      const state = await checkpoint(h);
      delete h.report.output.debts;
      delete h.report.output.humanDecision;
      const content = JSON.stringify(h.report);
      assert(state.judgment?.report);
      state.judgment.report.digest = content;
      h.artifacts.set(h.reportPath, { content, digest: content });
      await h.controller.stopRecording();
      const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
      await journal.load();
      await journal.commit({ ...state, version: 8 }, []);
      await journal.close();
      const restored = await h.restore();
      const ui = commands(restored);
      if (verdict === "ACCEPT_WITH_DEBT")
        ui.answers.push(
          "ACCEPT_WITH_DEBT",
          "1",
          "Legacy obligation",
          "Maintainer",
          "Before the next release",
          "Accept legacy debt",
          "CONFIRM",
        );
      else
        ui.answers.push(
          "REJECT",
          "Is the scope sufficient?",
          h.report.evaluation.planArtifactId,
          "Scope is insufficient",
          "CONFIRM",
        );
      assert.match(await ui.command(`approve ${h.reportId} ${h.revision}`), /closed:/);
      const resolution = (await restored.getRunStatus()).humanResolution;
      assert.deepEqual(resolution?.completedByHuman, [
        verdict === "ACCEPT_WITH_DEBT" ? "debts" : "humanDecision",
      ]);
      assert.equal(h.artifacts.get(h.reportPath)?.content, content);
    } finally {
      await h.cleanup();
    }
  }
});

test("interrupted resolution and summary writes resume the saved choice without silently applying on load", async () => {
  for (const suffix of [".json", ".md"]) {
    const h = await judged("HUMAN_DECISION");
    let controller: PiWorkflow | undefined;
    try {
      await h.controller.stopRecording();
      controller = new PiWorkflow(h.recorder, h.cwd, "session", {
        ...h.options,
        writeArtifact: async (...args) => {
          const path = await h.options.writeArtifact(...args);
          if (path.endsWith(suffix)) throw new Error("interrupted write");
          return path;
        },
      });
      await assert.rejects(
        controller.applyJudgment(h.reportId, h.revision, input(h, "ACCEPT")),
        /interrupted write/,
      );
      await controller.stopRecording();
      controller = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
      assert.equal((await controller.getRunStatus()).closure, undefined);
      const approval = await controller.prepareJudgmentApproval(h.reportId, h.revision);
      assert(!("applied" in approval) && approval.savedResolution);
      await assert.rejects(
        controller.applyJudgment(h.reportId, h.revision, input(h, "REJECT")),
        /conflicting/,
      );
      const headless = commands(controller);
      headless.ctx.hasUI = false;
      assert.match(
        await headless.command(`approve ${h.reportId} ${h.revision}`),
        /remains pending/,
      );
      assert.equal((await controller.getRunStatus()).closure, undefined);
      const ui = commands(controller);
      ui.answers.push("CONFIRM");
      assert.match(await ui.command(`approve ${h.reportId} ${h.revision}`), /closed: accepted/);
      assert.equal(ui.prompts.length, 1);
      assert.equal((await checkpoint(h)).closure?.resolution?.confirmedAt, 1000);
    } finally {
      await controller?.stopRecording();
      await h.cleanup();
    }
  }
});

test("human resolution remains local with unavailable, rejecting or unanswered recording", {
  timeout: 10000,
}, async () => {
  for (const mode of ["missing", "rejected", "unanswered"]) {
    const h = await judged("HUMAN_DECISION");
    let controller: PiWorkflow | undefined;
    try {
      await h.controller.stopRecording();
      const recorder = {
        appendEvents: async () => {
          if (mode === "unanswered") return new Promise<never>(() => {});
          throw new Error(mode);
        },
      };
      controller = new PiWorkflow(recorder, h.cwd, "session", h.options);
      assert.equal(
        (await controller.applyJudgment(h.reportId, h.revision, input(h, "ACCEPT"))).status,
        "accepted",
      );
      await controller.stopRecording();
      controller = new PiWorkflow(recorder, h.cwd, "session", h.options);
      assert.equal(
        (await controller.getRunStatus()).humanResolution?.reason,
        input(h, "ACCEPT").reason,
      );
      assert.equal((await controller.applyJudgment(h.reportId, h.revision)).replayed, true);
    } finally {
      await controller?.stopRecording();
      await h.cleanup();
    }
  }
});

test("Judge detail validation is additive for historical reports and mandatory for new special reports", async () => {
  const h = await judged("HUMAN_DECISION");
  try {
    const report = structuredClone(h.report);
    delete report.output.humanDecision;
    const parse = (strict = false) =>
      parseJudgmentReport(
        JSON.stringify(report),
        report.evaluation,
        report.output.assignmentId,
        strict,
      );
    assert.doesNotThrow(() => parse());
    assert.throws(() => parse(true), /structured/);
    report.output.humanDecision = { question: "Question", evidence: ["unknown"] };
    assert.throws(() => parse(), /evidence/);
    assert(h.report.output.humanDecision);
    report.output.humanDecision = h.report.output.humanDecision;
    report.output.debts = [
      { id: "d1", description: "Debt", owner: "Team", futureCondition: "Before release" },
    ];
    assert.doesNotThrow(() => parse(true));
    const approval = await h.controller.prepareJudgmentApproval(h.reportId, h.revision);
    assert(!("applied" in approval));
    // A human cannot hide newly supplied debt behind unconditional ACCEPT.
    await assert.rejects(
      h.controller.applyJudgment(h.reportId, h.revision, {
        ...input(h, "ACCEPT"),
        debts: report.output.debts,
      }),
      /all debt/,
    );
    report.output.debts.push(structuredClone(required(report.output.debts[0])));
    assert.throws(() => parse(), /debt/);
  } finally {
    await h.cleanup();
  }
});

test("damaged saved resolutions and checkpoint references cannot replace a human decision", async () => {
  const h = await judged("HUMAN_DECISION");
  let controller: PiWorkflow | undefined;
  try {
    await h.controller.stopRecording();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", {
      ...h.options,
      writeArtifact: async (...args) => {
        await h.options.writeArtifact(...args);
        throw new Error("interrupted");
      },
    });
    const resolution = input(h, "ACCEPT");
    await assert.rejects(
      controller.applyJudgment(h.reportId, h.revision, resolution),
      /interrupted/,
    );
    await controller.stopRecording();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
    const path = resolutionPath(h.reportId);
    const original = required(h.artifacts.get(path));
    for (const content of [
      "malformed",
      JSON.stringify({ ...JSON.parse(original.content), reportId: "other" }),
      JSON.stringify({ ...JSON.parse(original.content), evaluatedCommit: "f".repeat(40) }),
    ]) {
      h.artifacts.set(path, { content, digest: "changed" });
      await assert.rejects(controller.prepareJudgmentApproval(h.reportId, h.revision));
      await assert.rejects(controller.applyJudgment(h.reportId, h.revision, resolution));
      assert.equal((await controller.getRunStatus()).closure, undefined);
      assert.equal(h.artifacts.get(path)?.content, content);
    }
    h.artifacts.set(path, original);
    const applied = await controller.applyJudgment(h.reportId, h.revision, resolution);
    await controller.waitForRecording();
    const count = h.recorder.events.length;
    assert.deepEqual(await controller.applyJudgment(h.reportId, h.revision, resolution), {
      ...applied,
      replayed: true,
    });
    await controller.waitForRecording();
    assert.equal(h.recorder.events.length, count);
    const state = await checkpoint(h);
    for (const update of [
      { path: "../outside.json" },
      { digest: "invalid" },
      { confirmedAt: 0 },
      { artifact_id: "another" },
      { decision: "REJECT" },
    ]) {
      const corrupted = structuredClone(state);
      assert(corrupted.closure?.resolution);
      Object.assign(corrupted.closure.resolution, update);
      assert.throws(() => decodeAdapterCheckpoint(corrupted));
    }
    h.artifacts.set(path, { content: original.content, digest: "changed" });
    await assert.rejects(controller.getRunStatus(), /changed after registration/);
    h.artifacts.set(path, original);
    await controller.stopRecording();
    assert(state.closure?.resolution);
    state.closure.verdict = "REJECT";
    state.closure.status = "rejected";
    state.closure.resolution.decision = "REJECT";
    const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
    await journal.load();
    await journal.commit(state, []);
    await journal.close();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
    await assert.rejects(controller.getRunStatus(), /does not match the recorded decision/);
    await assert.rejects(
      controller.prepareJudgmentApproval(h.reportId, h.revision),
      /does not match the recorded decision/,
    );
    await assert.rejects(
      controller.applyJudgment(h.reportId, h.revision),
      /does not match the recorded decision/,
    );
  } finally {
    await controller?.stopRecording();
    await h.cleanup();
  }
});
