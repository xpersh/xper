import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createXperExtension } from "../extension.js";
import { PiWorkflow } from "../workflow/controller.js";
import { XperSession } from "../pi/session.js";
import { XperClient } from "../bridge/xper-client.js";
import { connectBridge } from "../bridge/client.js";
import { PiObservations } from "../pi/observations.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");

const temporaryWorkspaces: string[] = [];
after(() => {
  for (const directory of temporaryWorkspaces) rmSync(directory, { recursive: true, force: true });
});
function fakePi(cwd?: string) {
  if (!cwd) {
    cwd = mkdtempSync(join(tmpdir(), "xper-extension-"));
    temporaryWorkspaces.push(cwd);
  }
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
  const prompts: string[] = [];
  const answers: Array<string | undefined> = [];
  let command: ((args: string, ctx: unknown) => void) | undefined;
  let tool:
    | {
        execute: (
          id: string,
          params: { task: string; timeoutSeconds?: number; assignmentId?: string },
          signal: AbortSignal,
          onUpdate: unknown,
          ctx: unknown,
        ) => Promise<{ details: Record<string, unknown> }>;
      }
    | undefined;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      notify: (message: string) => messages.push(message),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      input: async (title: string) => {
        prompts.push(title);
        return answers.shift();
      },
    },
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => void }) => {
      assert.equal(name, "xper");
      command = options.handler;
    },
    registerTool: (value: typeof tool) => {
      tool = value;
    },
  } as Parameters<typeof createXperExtension>[0];
  return {
    pi,
    ctx,
    messages,
    statuses,
    prompts,
    answers,
    async emit(event: string, payload: unknown = {}) {
      const handler = handlers.get(event);
      assert(handler, `missing ${event} handler`);
      await handler(payload, ctx);
    },
    async connected() {
      await until(() => statuses.at(-1) === "xper connected");
    },
    async status() {
      assert(command);
      await command("status", ctx);
      return messages.at(-1) ?? "";
    },
    async command(args: string) {
      assert(command);
      await command(args, ctx);
      return messages.at(-1) ?? "";
    },
    async delegate(
      params: { task: string; timeoutSeconds?: number; assignmentId?: string },
      signal = new AbortController().signal,
    ) {
      assert(tool);
      return tool.execute("pi-tool-call-1", params, signal, undefined, ctx);
    },
  };
}

function pidFrom(status: string): number {
  const match = status.match(/pid (\d+)/);
  assert(match, status);
  return Number(match[1]);
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(await predicate(), "condition was not reached");
}

test("Pi extension connects, reports versions, forwards errors, and does not duplicate a bridge", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary });

  await harness.emit("session_start");
  await harness.connected();
  const first = await harness.status();
  assert.match(first, /adapter pi 0\.1\.0; protocol 1; bridge connected/);
  const firstPid = pidFrom(first);
  await harness.emit("session_start");
  await harness.connected();
  assert.equal(pidFrom(await harness.status()), firstPid);
  await harness.emit("tool_execution_end", {
    isError: true,
    toolName: "bash",
    toolCallId: "call-1",
  });
  await harness.emit("session_compact_failed");
  assert.match(await harness.status(), /connected/);

  await harness.emit("session_shutdown");
  await harness.emit("session_shutdown");
  assert.equal(harness.statuses.at(-1), undefined);
  await until(() => {
    try {
      process.kill(firstPid, 0);
      return false;
    } catch {
      return true;
    }
  });

  await harness.emit("session_start");
  await harness.connected();
  const secondPid = pidFrom(await harness.status());
  assert.notEqual(secondPid, firstPid);
  await harness.emit("session_shutdown");
  await until(() => {
    try {
      process.kill(secondPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("xper starts and resumes without an agent manager, with an objective dialog or arguments", async () => {
  for (const invocation of ["", "Explore this project", "start Explore this project"]) {
    const directory = mkdtempSync(join(tmpdir(), "xper-command-"));
    const harness = fakePi(directory);
    harness.answers.push("Explore this project");
    createXperExtension(harness.pi, { command: binary });
    try {
      await harness.emit("session_start");
      await harness.connected();
      const started = await harness.command(invocation);
      assert.match(started, /Started workflow .*; phase discovery/);
      assert.match(started, /xper_delegate/);
      assert.equal(harness.prompts.length, invocation ? 0 : 1);
      const runId = started.match(/workflow ([^;]+);/)?.[1];
      assert(runId);
      const resumed = await harness.command("start Continue this project");
      assert(resumed.includes(`Resumed workflow ${runId}; phase discovery`));
      assert.match(await harness.status(), /phase discovery/);
    } finally {
      await harness.emit("session_shutdown");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("xper does not start a workflow after cancelled or invalid control input", async (t) => {
  for (const scenario of [
    "cancel",
    "empty",
    "no-ui",
    "help",
    "invalid-subcommand",
    "resume-without-commit",
  ] as const) {
    await t.test(scenario, async () => {
      const directory = mkdtempSync(join(tmpdir(), "xper-command-input-"));
      const harness = fakePi(directory);
      harness.ctx.hasUI = scenario !== "no-ui";
      harness.answers.push(scenario === "empty" ? "  " : undefined);
      createXperExtension(harness.pi, { command: binary });
      try {
        await harness.emit("session_start");
        await harness.connected();
        const result = await harness.command(
          scenario === "help"
            ? "help"
            : scenario === "invalid-subcommand"
              ? "advance extra"
              : scenario === "resume-without-commit"
                ? "resume"
                : "",
        );
        assert.match(await harness.status(), /no run/);
        assert.equal(harness.prompts.length, scenario === "cancel" || scenario === "empty" ? 1 : 0);
        if (scenario === "no-ui") assert.match(result, /Provide an objective/);
        if (scenario === "empty") assert.match(result, /objective is required/);
        if (scenario === "help" || scenario === "invalid-subcommand")
          assert.match(result, /Usage:/);
        if (scenario === "resume-without-commit")
          assert.match(result, /Provide the clean checkout/);
      } finally {
        await harness.emit("session_shutdown");
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("Pi session stays usable after a bridge crash", async () => {
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary });
  await harness.emit("session_start");
  await harness.connected();
  const pid = pidFrom(await harness.status());
  process.kill(pid, "SIGKILL");
  await until(() => harness.statuses.at(-1) === "xper recorder offline");
  assert.match(await harness.status(), /bridge offline/);
  await harness.emit("session_shutdown");
  await harness.emit("session_start");
  await harness.connected();
  assert.match(await harness.status(), /bridge connected/);
  await harness.emit("session_shutdown");
});

test("missing bridge reports an actionable warning while a new local workflow starts", async () => {
  const harness = fakePi();
  createXperExtension(harness.pi, { command: resolve(workspace, "missing-xper-binary") });
  await harness.emit("session_start");
  await until(async () => (await harness.status()).includes("binary not found"));
  assert.match(await harness.status(), /binary not found.*cargo build -p xper-cli/);
  const result = await harness.command("Start without Rust");
  assert.match(result, /Started workflow .*phase discovery/);
  assert.match(result, /Configuration: Pi defaults/);
  assert.equal(harness.prompts.length, 0);
  await harness.emit("session_shutdown");
});

test("incompatible bridge gives rebuild guidance", async () => {
  const harness = fakePi();
  const reply = `process.stdin.once("data", () => process.stdout.write(JSON.stringify({jsonrpc:"2.0",protocolVersion:"1",id:"adapter-1",result:{protocolVersion:"2",bridgeVersion:"old"}})+"\\n"))`;
  createXperExtension(harness.pi, { command: process.execPath, args: ["-e", reply] });
  await harness.emit("session_start");
  await until(async () => (await harness.status()).includes("incompatible xper bridge"));
  assert.match(await harness.status(), /incompatible xper bridge.*Rebuild xper/);
  await harness.emit("session_shutdown");
});

test("observes Pi tool outcomes without interpreting another extension's details", async () => {
  const observations = new PiObservations(undefined, () => assert.fail("unexpected log error"));
  observations.toolStarted("subagent", "call-1");
  observations.toolEnded({
    toolName: "subagent",
    toolCallId: "call-1",
    isError: false,
    result: { details: { status: "error", isError: true, exitCode: 1 } },
  });
  observations.toolStarted("bash", "call-2");
  observations.toolEnded({
    toolName: "bash",
    toolCallId: "call-2",
    isError: true,
  });
  assert.deepEqual(observations.summary(), {
    started: 2,
    completed: 1,
    failed: 1,
    inFlight: 0,
    unpaired: 0,
  });
  await observations.sessionEnded("test");
});

test("records generic Pi tool signals without prompts or output", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-pi-observe-"));
  const journal = join(directory, "observations.jsonl");
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary, observationsFile: journal });
  try {
    await harness.emit("session_start", { reason: "startup" });
    await harness.connected();
    await harness.emit("tool_execution_start", {
      toolName: "bash",
      toolCallId: "call-error",
      args: { task: "secret prompt" },
    });
    await harness.emit("tool_execution_end", {
      toolName: "bash",
      toolCallId: "call-error",
      isError: true,
      result: {
        details: { status: "error", isError: true, exitCode: 1, output: "secret output" },
      },
    });
    await harness.emit("tool_execution_start", {
      toolName: "xper_delegate",
      toolCallId: "call-done",
    });
    await harness.emit("tool_execution_end", {
      toolName: "xper_delegate",
      toolCallId: "call-done",
      isError: false,
      result: { details: { status: "done", isError: false, exitCode: 0, output: "secret" } },
    });
    assert.match(await harness.status(), /tools observed: started 2, completed 1, failed 1/);
    await harness.emit("session_shutdown", { reason: "quit" });
    const text = readFileSync(journal, "utf8");
    assert.doesNotMatch(text, /secret/);
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(rows.some((row) => row.type === "session.start" && row.adapterVersion === "0.1.0"));
    assert(rows.every((row) => !("testedOpenAgentsVersion" in row)));
    assert(rows.some((row) => row.type === "bridge.connected"));
    assert(rows.some((row) => row.type === "command.invoked" && row.recognized === true));
    assert(rows.some((row) => row.type === "session.end" && row.completed === 1));
    assert(rows.some((row) => row.type === "tool.end" && row.toolName === "bash" && row.isError));
  } finally {
    await harness.emit("session_shutdown", { reason: "quit" });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotates the observation log and retains a bounded set of JSONL files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xper-pi-rotate-"));
  const journal = join(directory, "observations.jsonl");
  let writeErrors = 0;
  const observations = new PiObservations(journal, () => writeErrors++, {
    maxBytes: 512,
    maxFiles: 3,
  });
  try {
    for (let index = 0; index < 30; index++) {
      observations.record("probe", { index });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await observations.sessionEnded("test");
    assert.equal(writeErrors, 0);
    const files = readdirSync(directory).filter((name) => name.startsWith("observations"));
    assert(files.includes("observations.jsonl"));
    assert(files.length > 1 && files.length <= 3, files.join(", "));
    assert.match(readFileSync(journal, "utf8"), /"type":"session.end"/);
    for (const file of files) {
      const content = readFileSync(join(directory, file), "utf8").trim();
      for (const line of content.split("\n")) {
        const row = JSON.parse(line);
        assert.equal(row.level, "info");
        assert.equal(typeof row.session, "string");
      }
    }
  } finally {
    await observations.sessionEnded("test");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps in-memory observations when the log path cannot be opened", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xper-pi-log-error-"));
  let writeErrors = 0;
  try {
    const observations = new PiObservations(directory, () => writeErrors++);
    observations.toolStarted("subagent", "call-1");
    assert.equal(observations.summary().started, 1);
    assert.equal(writeErrors, 1);
    await observations.sessionEnded("test");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("workflow start, delegation and advancement do not await a missing or unresponsive Rust process", async () => {
  const previous = process.env.XPER_PI_COMMAND;
  try {
    for (const scenario of ["missing", "unresponsive"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "xper-independent-pi-"));
      const child = join(directory, "fake-pi.mjs");
      writeFileSync(
        child,
        `#!/usr/bin/env node
process.stdin.once("data",()=>{
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"# Brief\\nIndependent evidence"}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
process.stdin.on("end",()=>process.exit(0));
});`,
      );
      chmodSync(child, 0o755);
      process.env.XPER_PI_COMMAND = child;
      const harness = fakePi(directory);
      createXperExtension(
        harness.pi,
        scenario === "missing"
          ? { command: join(directory, "missing-rust") }
          : {
              command: process.execPath,
              args: ["-e", "process.stdin.resume()"],
              requestTimeoutMs: 10000,
            },
      );
      try {
        const start = performance.now();
        await harness.emit("session_start");
        assert.match(
          await harness.command("Work independently"),
          /Started workflow .*phase discovery/,
        );
        assert.match(await harness.command("advance"), /"advanced":false/);
        const result = await harness.delegate({ task: "Inspect synthetic evidence" });
        assert.equal(result.details.outcome, "succeeded");
        assert.equal(result.details.phase, "define");
        assert(
          performance.now() - start < 2000,
          "workflow must finish before the 10-second bridge timeout",
        );
        assert.match(await harness.status(), /configuration: Pi defaults/);
      } finally {
        await harness.emit("session_shutdown");
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.XPER_PI_COMMAND;
    else process.env.XPER_PI_COMMAND = previous;
  }
});

test("offline new runs use the prepared workspace snapshot and report that it is cached", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xper-cached-configuration-"));
  mkdirSync(join(directory, ".xper", "pi"), { recursive: true });
  writeFileSync(
    join(directory, ".xper", "pi", "configuration.json"),
    JSON.stringify({
      version: 1,
      configuration: {
        routing: {
          profile: "prepared",
          context: "test",
          routes: {
            "discovery.explorer": [
              { context: "test", provider: "synthetic", model: "prepared-model", thinking: "off" },
            ],
          },
        },
        adapterConfig: { maxAttempts: 1 },
      },
    }),
  );
  const harness = fakePi(directory);
  createXperExtension(harness.pi, { command: join(directory, "missing-rust") });
  try {
    await harness.emit("session_start");
    const started = await harness.command("Use cached preparation");
    assert.match(started, /Configuration: cached configuration \(profile prepared\)/);
    const stateFiles = readdirSync(join(directory, ".xper", "pi")).filter(
      (file) => file !== "configuration.json" && file.endsWith(".json"),
    );
    assert.equal(stateFiles.length, 1);
    const state = JSON.parse(
      readFileSync(join(directory, ".xper", "pi", stateFiles[0] ?? ""), "utf8"),
    ) as {
      state: {
        knowledge: { routing: { profile: string }; policy: { maxAttempts: number } };
      };
    };
    assert.equal(state.state.knowledge.routing.profile, "prepared");
    assert.equal(state.state.knowledge.policy.maxAttempts, 1);
  } finally {
    await harness.emit("session_shutdown");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconnection preserves a live attempt and a changed Pi session gets a separate controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xper-rebind-controller-"));
  const harness = fakePi(directory);
  const session = new XperSession({ command: binary });
  try {
    await session.start(harness.ctx, "startup");
    const workflow = session.workflow;
    assert(workflow);
    await until(() => session.connection !== undefined);
    await workflow.startRun("Keep a running attempt");
    const attempt = await workflow.startAssignment();
    const firstConnection = session.connection;
    assert(firstConnection);
    firstConnection.client.close();
    await until(() => session.error !== undefined);
    await session.start(harness.ctx, "reconnect");
    assert.equal(session.workflow, workflow);
    await until(() => session.connection !== undefined);
    assert.equal((await workflow.getRunStatus()).run?.attempts[attempt.attemptId]?.outcome, null);
    await workflow.finishAttempt({ attemptId: attempt.attemptId, outcome: "failed" });
    harness.ctx.sessionManager.getSessionId = () => "a-different-pi-session";
    await session.start(harness.ctx, "changed");
    assert.notEqual(session.workflow, workflow);
    await until(() => session.connection?.sessionId === "a-different-pi-session");
    assert.equal((await session.workflow?.getRunStatus())?.run, null);
  } finally {
    await session.stop(harness.ctx, "test");
    rmSync(directory, { recursive: true, force: true });
  }
});
