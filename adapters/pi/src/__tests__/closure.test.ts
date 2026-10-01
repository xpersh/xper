import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { ProtocolFailure } from "../bridge/protocol.js";
import { connectBridge } from "../bridge/client.js";
import { XperClient } from "../bridge/xper-client.js";
import { registerXperCommand } from "../pi/xper-command.js";
import { XperSession } from "../pi/session.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import type { AdapterCheckpoint } from "../workflow/checkpoint/types.js";
import { PiWorkflow } from "../workflow/controller.js";
import { closeRun } from "../workflow/delivery/closure.js";
import { WorkflowJournal } from "../workflow/journal.js";
import type { JudgmentReport, Verdict } from "../workflow/judgment/contract.js";
import { ready, reportFor } from "./judgment-harness.js";
import { binary, fakePi, workspace } from "./extension-harness.js";
import { setup } from "./workflow-harness.js";

async function judged(verdict: Verdict = "ACCEPT") {
  const h = await ready();
  try {
    const started = await h.controller.startAssignment(undefined, "provider/judge");
    assert(started.workflow === "judgment" && started.artifactPath);
    const report = JSON.parse(reportFor(started)) as JudgmentReport;
    report.output.verdict = verdict;
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
async function checkpoint(h: Awaited<ReturnType<typeof ready>>): Promise<AdapterCheckpoint> {
  const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
  await journal.load();
  const state = decodeAdapterCheckpoint(journal.state);
  assert(state);
  return state;
}

test("explicit ACCEPT and REJECT persist one closure and summary, with immutable replay after reload", async () => {
  for (const verdict of ["ACCEPT", "REJECT"] as const) {
    const h = await judged(verdict);
    try {
      const before = await checkpoint(h);
      h.advanceTime(10_000_000); // Closure needs no remaining model execution budget.
      const result = await h.controller.applyJudgment(h.reportId, h.revision);
      assert.equal(result.status, verdict === "ACCEPT" ? "accepted" : "rejected");
      assert.equal(result.replayed, false);
      assert.deepEqual(result.incrementIds, ["s1", "s2"]);
      const summary = await readFile(join(h.cwd, result.summary.path), "utf8");
      assert(summary.includes(h.reportId) && summary.includes(h.revision));
      for (const reference of h.started.evaluation.artifacts)
        assert(summary.includes(reference.path.split("/").at(-1) ?? "missing"));
      assert.match(
        summary,
        /## Criteria[\s\S]*## Decisions and evidence[\s\S]*## Unresolved findings/,
      );
      assert.match(
        summary,
        verdict === "REJECT" ? /uncertain[\s\S]*Integration risk/ : /No unresolved findings/,
      );
      const pureInput = structuredClone(before);
      const pure = closeRun(pureInput, h.reportId, h.revision, result.summary, result.closedAt);
      assert.deepEqual(pureInput, before);
      assert.deepEqual(pure.result, result);
      assert.deepEqual(closeRun(pure.state, h.reportId, h.revision, result.summary, 0).facts, []);
      await h.controller.waitForRecording();
      const events = h.recorder.events;
      assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
      assert.equal(events.filter((e) => e.type === "judgment.applied").length, 1);
      const accepted = events.filter((e) => e.type === "increment.accepted");
      assert.equal(accepted.length, verdict === "ACCEPT" ? 2 : 0);
      for (const event of accepted) {
        assert.equal(event.data.reportId, h.reportId);
        assert.equal(event.data.evaluatedCommit, h.revision);
        assert(event.data.implementationArtifactId && event.data.verificationArtifactId);
      }
      const count = events.length;
      h.artifacts.clear();
      h.setWorkspace({ root: h.cwd, head: "9".repeat(40), clean: false, status: "changed" });
      const restored = await h.restore();
      const replay = await restored.applyJudgment(h.reportId, h.revision);
      assert.deepEqual(replay, { ...result, replayed: true });
      assert.equal(await readFile(join(h.cwd, replay.summary.path), "utf8"), summary);
      assert.equal((await restored.getRunStatus()).judgment?.applied, true);
      assert.deepEqual((await restored.getRunStatus()).closure, pure.state.closure);
      await assert.rejects(restored.applyJudgment("wrong", h.revision), /exact Judge report/);
      await assert.rejects(
        restored.applyJudgment(h.reportId, "9".repeat(40)),
        /exact Judge report/,
      );
      for (const operation of [
        () => restored.startRun("new"),
        () => restored.startAssignment(),
        () => restored.advanceRun(),
        () => restored.resumeDelivery(h.revision),
      ])
        await assert.rejects(operation(), /run is closed/);
      await restored.waitForRecording();
      assert.equal(events.length, count);
    } finally {
      await h.cleanup();
    }
  }
});

test("first application rejects wrong identities, revisions, changed reports, inputs, logs and checkout", async () => {
  const h = await judged();
  try {
    await assert.rejects(h.controller.applyJudgment("unknown", h.revision), /exact Judge report/);
    for (const revision of ["HEAD", "abcd", h.revision.slice(0, 39), "a".repeat(41)])
      await assert.rejects(h.controller.applyJudgment(h.reportId, revision), /full lowercase Git/);
    await assert.rejects(
      h.controller.applyJudgment(h.reportId, "a".repeat(40)),
      /exact Judge report/,
    );
    await assert.rejects(h.controller.advanceRun(h.reportId), /approve <reportId> <commit>/);
    const paths = [
      h.reportPath,
      ...h.started.evaluation.artifacts.map((a) => a.path),
      ...h.started.evaluation.logs.map((log) => log.path),
    ];
    for (const path of paths) {
      const original = h.artifacts.get(path);
      assert(original);
      h.artifacts.set(path, { ...original, digest: "changed" });
      await assert.rejects(h.controller.applyJudgment(h.reportId, h.revision), /changed/);
      h.artifacts.set(path, original);
    }
    const original = h.artifacts.get(h.reportPath);
    assert(original);
    for (const content of [
      "not JSON",
      JSON.stringify({ ...h.report, output: { ...h.report.output, verdict: "REJECT" } }),
    ]) {
      h.artifacts.set(h.reportPath, { ...original, content });
      await assert.rejects(h.controller.applyJudgment(h.reportId, h.revision), /JSON|registration/);
    }
    h.artifacts.set(h.reportPath, original);
    for (const workspace of [
      { head: h.revision, clean: false },
      { head: "a".repeat(40), clean: true },
    ]) {
      h.setWorkspace({ root: h.cwd, status: "", ...workspace });
      await assert.rejects(
        h.controller.applyJudgment(h.reportId, h.revision),
        /clean evaluated revision/,
      );
    }
    assert.equal((await h.controller.getRunStatus()).closure, undefined);
    await h.controller.waitForRecording();
    assert(!h.recorder.events.some((e) => e.type === "run.finished"));
  } finally {
    await h.cleanup();
  }
});

test("unsupported recommendations stay pending without summary writes or closure", async () => {
  for (const verdict of [
    "ACCEPT_WITH_DEBT",
    "REWORK_IMPLEMENTATION",
    "REVISIT_DESIGN",
    "REDEFINE",
    "HUMAN_DECISION",
  ] as const) {
    const h = await judged(verdict);
    try {
      await assert.rejects(
        h.controller.applyJudgment(h.reportId, h.revision),
        /unsupported.*pending/,
      );
      assert.equal((await h.controller.getRunStatus()).judgment?.applied, false);
      assert.equal((await h.controller.getRunStatus()).closure, undefined);
      await assert.rejects(readFile(join(h.cwd, `.xper/artifacts/run-summary-${h.reportId}.md`)));
    } finally {
      await h.cleanup();
    }
  }
});

test("summary write failures leave the decision pending; interrupted writes can be reused but never overwritten", async () => {
  const h = await judged();
  let controller: PiWorkflow | undefined;
  try {
    await h.controller.stopRecording();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", {
      ...h.options,
      writeArtifact: async () => {
        throw new Error("disk unavailable");
      },
    });
    await assert.rejects(controller.applyJudgment(h.reportId, h.revision), /disk unavailable/);
    assert.equal((await controller.getRunStatus()).closure, undefined);
    await controller.stopRecording();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", {
      ...h.options,
      writeArtifact: async (...args) => {
        await h.options.writeArtifact(...args);
        throw new Error("interrupted");
      },
    });
    await assert.rejects(controller.applyJudgment(h.reportId, h.revision), /interrupted/);
    assert.equal((await controller.getRunStatus()).closure, undefined);
    const path = `.xper/artifacts/run-summary-${h.reportId}.md`;
    const original = h.artifacts.get(path);
    assert(original);
    await controller.stopRecording();
    controller = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
    await writeFile(join(h.cwd, path), "unrelated evidence");
    h.artifacts.set(path, { content: "unrelated evidence", digest: "changed" });
    await assert.rejects(controller.applyJudgment(h.reportId, h.revision), /summary differs/);
    assert.equal(await readFile(join(h.cwd, path), "utf8"), "unrelated evidence");
    await writeFile(join(h.cwd, path), original.content);
    h.artifacts.set(path, original);
    assert.equal((await controller.applyJudgment(h.reportId, h.revision)).status, "accepted");
  } finally {
    await controller?.stopRecording();
    await h.cleanup();
  }
});

test("closure references are validated and pre-closure checkpoints migrate without inventing decisions", async () => {
  const h = await judged();
  try {
    const pending = await checkpoint(h);
    const { closure: _closure, ...legacy } = pending;
    const migrated = decodeAdapterCheckpoint({ ...legacy, version: 6 });
    assert.deepEqual(migrated, pending);
    assert.throws(() => decodeAdapterCheckpoint({ ...legacy, version: 7 }), /envelope/);
    assert.throws(() => decodeAdapterCheckpoint({ ...legacy, version: "7" }));
    await h.controller.applyJudgment(h.reportId, h.revision);
    const closed = await checkpoint(h);
    for (const mutation of [
      { reportId: "other" },
      { reportDigest: "wrong" },
      { planArtifactId: "obsolete" },
      { evaluatedCommit: "a".repeat(40) },
      { verdict: "REJECT" },
      { status: "rejected" },
      { incrementIds: ["s1"] },
      { closedAt: -1 },
      { summary: { ...closed.closure?.summary, path: "../outside.md" } },
      { summary: { ...closed.closure?.summary, digest: "" } },
    ])
      assert.throws(
        () => decodeAdapterCheckpoint({ ...closed, closure: { ...closed.closure, ...mutation } }),
        /closure/,
      );
    assert.deepEqual(decodeAdapterCheckpoint(closed), closed);
  } finally {
    await h.cleanup();
  }
});

test("closure and local recovery finish before missing, rejecting or unanswered Rust", {
  timeout: 5000,
}, async () => {
  for (const mode of ["missing", "rejected", "unanswered"]) {
    const h = await judged();
    let release = () => {};
    let restored: PiWorkflow | undefined;
    const append = h.recorder.appendEvents;
    try {
      await h.controller.waitForRecording();
      h.recorder.appendEvents = async () => {
        if (mode === "missing") throw new Error("offline");
        if (mode === "rejected") throw new ProtocolFailure(-32602, "rejected");
        return new Promise((resolve) => {
          release = () => resolve({ accepted: 0, durability: "persistent" });
        });
      };
      const decision = await h.controller.applyJudgment(h.reportId, h.revision);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(decision.status, "accepted");
      assert.equal((await h.controller.getRunStatus()).closure?.reportId, h.reportId);
      await h.controller.stopRecording();
      restored = new PiWorkflow(h.recorder, h.cwd, "session", h.options);
      assert.equal((await restored.getRunStatus()).closure?.reportId, h.reportId);
      assert.equal((await restored.applyJudgment(h.reportId, h.revision)).replayed, true);
      assert.match((await restored.getRunStatus()).degradedReason ?? "", /pending|rejected/);
      await restored.stopRecording();
    } finally {
      h.recorder.appendEvents = append;
      release();
      await restored?.stopRecording();
      await h.cleanup();
    }
  }
});

function commands(workflow: PiWorkflow) {
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

test("Pi approve preserves human gates and requires an exact report and revision for closure", async () => {
  const knowledge = await setup({ humanGates: ["define"] });
  try {
    await knowledge.produce();
    await knowledge.controller.advanceRun();
    const definition = await knowledge.produce();
    assert(!definition.result.replayed && definition.result.artifactId);
    await knowledge.controller.advanceRun();
    const ui = commands(knowledge.controller);
    assert.match(await ui.command(`approve ${definition.result.artifactId}`), /"phase":"design"/);
  } finally {
    await knowledge.cleanup();
  }
  const h = await judged();
  try {
    const ui = commands(h.controller);
    const exact = `approve ${h.reportId} ${h.revision}`;
    assert((await ui.status()).includes(`/xper ${exact}`));
    assert.match(await ui.command(`approve ${h.reportId}`), /<reportId> <commit>/);
    assert.match(await ui.command(`${exact} extra`), /Provide the human gate/);
    assert.match(await ui.command(exact), /closed: accepted.*Run summary/);
    assert.match(await ui.status(), /closed: accepted.*Run summary/);
    assert.doesNotMatch(await ui.status(), /recommendation not applied/);
    assert.match(await ui.command(exact), /existing decision/);
  } finally {
    await h.cleanup();
  }
});

test("the real bridge records acceptance and rejection facts and projects closure without workflow rules", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  for (const verdict of ["ACCEPT", "REJECT"] as const) {
    const h = await judged(verdict);
    let bridge: Awaited<ReturnType<typeof connectBridge>>["client"] | undefined;
    try {
      const decision = await h.controller.applyJudgment(h.reportId, h.revision);
      await h.controller.waitForRecording();
      const home = join(h.cwd, "home");
      await mkdir(home);
      ({ client: bridge } = await connectBridge(
        { adapter: "pi", adapterVersion: "test", capabilities: {} },
        {
          command: "/usr/bin/env",
          args: [`HOME=${home}`, binary, "bridge", "--stdio"],
          cwd: h.cwd,
        },
      ));
      await bridge.request("session.attach", {
        sessionId: "closure-test",
        cwd: h.cwd,
        mode: "rpc",
      });
      const client = new XperClient(bridge);
      const facts = h.recorder.events.filter((event) =>
        ["run.started", "judgment.applied", "increment.accepted", "run.finished"].includes(
          event.type,
        ),
      );
      assert.equal((await client.appendEvents(facts)).durability, "persistent");
      assert.equal((await client.appendEvents(facts)).accepted, 0);
      const recorded = await client.getRunStatus(decision.runId);
      assert.equal(recorded.run?.status, decision.status);
      assert.equal(recorded.timeline.filter((event) => event.type === "run.finished").length, 1);
    } finally {
      await bridge?.shutdown();
      await h.cleanup();
    }
  }
});
