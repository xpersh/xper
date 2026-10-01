import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectBridge } from "../bridge/client.js";
import { XperClient } from "../bridge/xper-client.js";
import { createXperExtension } from "../extension.js";
import { PiWorkflow } from "../workflow/controller.js";
import { binary, fakePi, pidFrom, until, workspace } from "./extension-harness.js";

test("vertical slice persists Discovery, gates Define, recovers the bridge, and distinguishes outcomes", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-vertical-"));
  const fakeChild = join(directory, "fake-pi.mjs");
  writeFileSync(
    fakeChild,
    `#!/usr/bin/env node
process.stdin.once("data", () => {
  if (process.env.XPER_FAKE_OUTCOME === "failed") process.exit(1);
  if (process.env.XPER_FAKE_OUTCOME === "waiting") { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"# Discovery Brief\\nEvidence found.\\nRisks and open questions."}]}})+"\\n");
  process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
  process.stdin.on("end", () => process.exit(0));
});


`,
  );
  chmodSync(fakeChild, 0o755);
  const previousCommand = process.env.XPER_PI_COMMAND;
  const previousOutcome = process.env.XPER_FAKE_OUTCOME;
  process.env.XPER_PI_COMMAND = fakeChild;
  try {
    for (const scenario of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      const cwd = join(directory, scenario);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(cwd);
      const journal = join(cwd, "observations.jsonl");
      const harness = fakePi(cwd);
      createXperExtension(harness.pi, { command: binary, observationsFile: journal });
      await harness.emit("session_start");
      await harness.connected();
      assert.match(
        await harness.command("Explore this project"),
        /Started workflow .*; phase discovery/,
      );
      assert.match(await harness.command("advance"), /"advanced":false/);
      if (scenario === "succeeded") {
        await harness.emit("session_shutdown");
        await harness.emit("session_start");
        await harness.connected();
        assert.match(await harness.status(), /phase discovery/);
      }
      process.env.XPER_FAKE_OUTCOME =
        scenario === "succeeded" || scenario === "failed" ? scenario : "waiting";
      const controller = new AbortController();
      if (scenario === "cancelled") setTimeout(() => controller.abort(), 50);
      const result = await harness.delegate(
        { task: "inspect evidence", timeoutSeconds: scenario === "timed_out" ? 1 : 5 },
        controller.signal,
      );
      assert.equal(result.details.outcome, scenario);
      assert.equal(result.details.phase, scenario === "succeeded" ? "define" : "discovery");
      await until(() => {
        const recorded = JSON.parse(
          execFileSync(binary, ["status", "--json"], { cwd, encoding: "utf8" }),
        ) as { run: { phase?: string; metrics?: { attemptsFinished: number } } | null };
        return (
          recorded.run?.metrics?.attemptsFinished === 1 &&
          recorded.run.phase === (scenario === "succeeded" ? "define" : "discovery")
        );
      });
      const status = JSON.parse(
        execFileSync(binary, ["status", "--json"], { cwd, encoding: "utf8" }),
      ) as {
        run: {
          phase: string;
          metrics: { outcomes: Record<string, number>; attemptsStarted: number };
        };
        timeline: Array<{
          type: string;
          data: { outcome?: string; phase?: string; attemptId?: string };
        }>;
      };
      const run = status.run;
      assert.equal(run.phase, scenario === "succeeded" ? "define" : "discovery");
      assert.equal(run.metrics.outcomes[scenario], 1);
      assert.equal(status.timeline.filter((event) => event.type === "attempt.finished").length, 1);
      assert.equal(
        status.timeline.filter((event) => event.type === "artifact.registered").length,
        scenario === "succeeded" ? 1 : 0,
      );
      assert.match(await harness.status(), new RegExp(`attempts ${scenario}`));
      if (scenario === "succeeded") {
        assert(status.timeline.some((event) => event.type === "artifact.registered"));
        assert(status.timeline.some((event) => event.type === "gate.failed"));
        assert(
          status.timeline.some(
            (event) => event.type === "phase.entered" && event.data.phase === "define",
          ),
        );
        assert.doesNotMatch(JSON.stringify(status.timeline), /inspect evidence|Evidence found/);
        await harness.emit("session_shutdown");
        await harness.emit("session_start");
        await harness.connected();
        assert.match(await harness.status(), /phase define/);
      } else {
        assert.match(await harness.command("advance"), /"advanced":false/);
      }
      await harness.emit("session_shutdown");
      const observations = readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              toolCallId?: string;
              attemptId?: string;
              outcome?: string;
            },
        );
      const correlated = observations.find((row) => row.type === "attempt.correlated");
      assert.equal(correlated?.toolCallId, "pi-tool-call-1");
      assert.equal(
        correlated?.attemptId,
        status.timeline.find((event) => event.type === "attempt.started")?.data.attemptId,
      );
      assert(
        observations.some(
          (row) =>
            row.type === "attempt.finished" &&
            row.attemptId === correlated?.attemptId &&
            row.outcome === scenario,
        ),
      );
      assert.doesNotMatch(JSON.stringify(observations), /inspect evidence|Evidence found/);
    }
  } finally {
    if (previousCommand === undefined) delete process.env.XPER_PI_COMMAND;
    else process.env.XPER_PI_COMMAND = previousCommand;
    if (previousOutcome === undefined) delete process.env.XPER_FAKE_OUTCOME;
    else process.env.XPER_FAKE_OUTCOME = previousOutcome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge crash interrupts an attempt and permits retry on the same assignment", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-retry-"));
  const manifest = { adapter: "pi", adapterVersion: "0.1.0", capabilities: { subagents: true } };
  const workflows: PiWorkflow[] = [];
  try {
    const first = await connectBridge(manifest, { command: binary });
    await first.client.request("session.attach", { sessionId: "s1", cwd: directory, mode: "rpc" });
    const firstWorkflow = new PiWorkflow(new XperClient(first.client), directory, "s1");
    workflows.push(firstWorkflow);
    await firstWorkflow.startRun("retry after interruption");
    const assigned = await firstWorkflow.startAssignment();
    await firstWorkflow.waitForRecording();
    await firstWorkflow.stopRecording();
    const closed = new Promise<void>((resolve) =>
      first.client.process.once("close", () => resolve()),
    );
    first.client.close();
    await closed;
    const second = await connectBridge(manifest, { command: binary });
    const workflow = new PiWorkflow(new XperClient(second.client), directory, "s1");
    workflows.push(workflow);
    try {
      await second.client.request("session.attach", {
        sessionId: "s1",
        cwd: directory,
        mode: "rpc",
      });
      const recovered = await workflow.getRunStatus();
      const projection = recovered.run as { attempts: Record<string, { outcome: string }> };
      assert.equal(projection.attempts[assigned.attemptId as string]?.outcome, "interrupted");
      const retry = await workflow.startAssignment(assigned.assignmentId);
      assert.equal(retry.assignmentId, assigned.assignmentId);
      assert.notEqual(retry.attemptId, assigned.attemptId);
      await workflow.finishAttempt({
        attemptId: retry.attemptId,
        outcome: "failed",
      });
      const status = await workflow.getRunStatus();
      assert.equal(
        (status.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
        "discovery",
      );
    } finally {
      await workflow.stopRecording();
      await second.client.shutdown();
    }
  } finally {
    await Promise.all(workflows.map((workflow) => workflow.stopRecording()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two Pi sessions stay isolated while one run has parallel delegations", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-concurrent-"));
  const manifest = { adapter: "pi", adapterVersion: "0.1.0", capabilities: { subagents: true } };
  const first = await connectBridge(manifest, { command: binary });
  const second = await connectBridge(manifest, { command: binary });
  const firstWorkflow = new PiWorkflow(new XperClient(first.client), directory, "parallel-1");
  const secondWorkflow = new PiWorkflow(new XperClient(second.client), directory, "parallel-2");
  try {
    await Promise.all([
      first.client.request("session.attach", {
        sessionId: "parallel-1",
        cwd: directory,
        mode: "rpc",
      }),
      second.client.request("session.attach", {
        sessionId: "parallel-2",
        cwd: directory,
        mode: "rpc",
      }),
    ]);
    const [one, two] = await Promise.all([
      firstWorkflow.startRun("first"),
      secondWorkflow.startRun("second"),
    ]);
    assert.notEqual(one.runId, two.runId);
    const [statusOne, statusTwo] = await Promise.all([
      firstWorkflow.getRunStatus(),
      secondWorkflow.getRunStatus(),
    ]);
    assert.equal((statusOne.run as { run_id: string }).run_id, one.runId);
    assert.equal((statusTwo.run as { run_id: string }).run_id, two.runId);
    await Promise.all([firstWorkflow.waitForRecording(), secondWorkflow.waitForRecording()]);
    const inspected = JSON.parse(
      execFileSync(binary, ["status", "--json", "--run", one.runId as string], {
        cwd: directory,
        encoding: "utf8",
      }),
    ) as { run: { runId: string } };
    assert.equal(inspected.run.runId, one.runId);

    await assert.rejects(
      second.client.request("run.join", { runId: one.runId }),
      /method not found/,
    );
    const [assignmentOne, assignmentTwo, otherSessionAssignment] = await Promise.all([
      firstWorkflow.startAssignment(),
      firstWorkflow.startAssignment(),
      secondWorkflow.startAssignment(),
    ]);
    assert.notEqual(assignmentOne.assignmentId, assignmentTwo.assignmentId);
    assert.notEqual(assignmentOne.attemptId, assignmentTwo.attemptId);
    assert.equal(assignmentOne.runId, one.runId);
    assert.equal(assignmentTwo.runId, one.runId);
    assert.equal(otherSessionAssignment.runId, two.runId);
    const artifacts = join(directory, ".xper", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const brief = `.xper/artifacts/discovery-brief-${assignmentOne.attemptId}.md`;
    writeFileSync(join(directory, brief), "Discovery evidence");
    await firstWorkflow.finishAttempt({
      attemptId: assignmentOne.attemptId,
      outcome: "succeeded",
      artifactPath: brief,
    });
    const waiting = await firstWorkflow.advanceRun();
    assert.equal(waiting.advanced, false);
    assert.match(waiting.reason as string, /still running/);
    await firstWorkflow.finishAttempt({
      attemptId: assignmentTwo.attemptId,
      outcome: "failed",
    });
    const advanced = await firstWorkflow.advanceRun();
    assert.equal(advanced.advanced, true);
    const isolated = await firstWorkflow.getRunStatus();
    assert.equal(
      (isolated.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
      "define",
    );
    assert.equal(Object.keys((isolated.run as { attempts: object }).attempts).length, 2);
    const otherSessionStatus = await secondWorkflow.getRunStatus();
    assert.equal((otherSessionStatus.run as { run_id: string }).run_id, two.runId);
    assert.equal(
      (otherSessionStatus.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
      "discovery",
    );
    assert.equal(Object.keys((otherSessionStatus.run as { attempts: object }).attempts).length, 1);
  } finally {
    await Promise.all([firstWorkflow.stopRecording(), secondWorkflow.stopRecording()]);
    await Promise.allSettled([first.client.shutdown(), second.client.shutdown()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a configured Pi workflow keeps executing when its recorder dies and syncs on reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xper-offline-workflow-"));
  const fakeChild = join(directory, "fake-pi.mjs");
  writeFileSync(
    fakeChild,
    `#!/usr/bin/env node
process.stdin.once("data",()=>{
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"# Brief\\nOffline evidence"}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
process.stdin.on("end",()=>process.exit(0));
});`,
  );
  chmodSync(fakeChild, 0o755);
  const previous = process.env.XPER_PI_COMMAND;
  process.env.XPER_PI_COMMAND = fakeChild;
  const harness = fakePi(directory);
  createXperExtension(harness.pi, { command: binary });
  try {
    await harness.emit("session_start");
    await harness.connected();
    await harness.command("Start while recorder is available");
    process.kill(pidFrom(await harness.status()), "SIGKILL");
    await until(() => harness.statuses.at(-1) === "xper recorder offline");
    const result = await harness.delegate({ task: "Keep working offline" });
    assert.equal(result.details.outcome, "succeeded");
    assert.equal(result.details.phase, "define");
    assert.match(await harness.status(), /telemetry:.*pending/);
    await harness.emit("session_shutdown");
    await harness.emit("session_start");
    await harness.connected();
    assert.match(await harness.status(), /phase define/);
    await until(() => {
      const recorded = JSON.parse(
        execFileSync(binary, ["status", "--json"], { cwd: directory, encoding: "utf8" }),
      ) as { run: { phase?: string; metrics?: { attemptsFinished: number } } | null };
      return recorded.run?.phase === "define" && recorded.run.metrics?.attemptsFinished === 1;
    });
    const saved = JSON.parse(
      execFileSync(binary, ["status", "--json"], { cwd: directory, encoding: "utf8" }),
    ) as { run: { phase: string; metrics: { attemptsFinished: number } } };
    assert.equal(saved.run.phase, "define");
    assert.equal(saved.run.metrics.attemptsFinished, 1);
  } finally {
    await harness.emit("session_shutdown");
    if (previous === undefined) delete process.env.XPER_PI_COMMAND;
    else process.env.XPER_PI_COMMAND = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
