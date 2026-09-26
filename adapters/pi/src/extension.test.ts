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
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXperExtension, isPiToolError } from "./extension.js";
import { connectBridge } from "./bridge.js";
import { PiObservations } from "./observations.js";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");

function fakePi(cwd = workspace) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
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
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      notify: (message: string) => messages.push(message),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    registerCommand: (
      _name: string,
      options: { handler: (args: string, ctx: unknown) => void },
    ) => {
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
    async emit(event: string, payload: unknown = {}) {
      const handler = handlers.get(event);
      assert(handler, `missing ${event} handler`);
      await handler(payload, ctx);
    },
    status() {
      assert(command);
      command("status", ctx);
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

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(predicate(), "condition was not reached");
}

test("Pi extension connects, reports versions, forwards errors, and does not duplicate a bridge", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary });

  await harness.emit("session_start");
  const first = harness.status();
  assert.match(first, /adapter pi 0\.1\.0; protocol 1; bridge connected/);
  const firstPid = pidFrom(first);
  await harness.emit("session_start");
  assert.equal(pidFrom(harness.status()), firstPid);
  await harness.emit("tool_execution_end", {
    isError: true,
    toolName: "bash",
    toolCallId: "call-1",
  });
  await harness.emit("session_compact_failed");
  assert.match(harness.status(), /connected/);

  await harness.emit("session_shutdown");
  await harness.emit("session_shutdown");
  assert.equal(harness.statuses.at(-1), undefined);
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });

  await harness.emit("session_start");
  const secondPid = pidFrom(harness.status());
  assert.notEqual(secondPid, firstPid);
  await harness.emit("session_shutdown");
  assert.throws(() => process.kill(secondPid, 0), { code: "ESRCH" });
});

test("Pi session stays usable after a bridge crash", async () => {
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary });
  await harness.emit("session_start");
  const pid = pidFrom(harness.status());
  process.kill(pid, "SIGKILL");
  await until(() => harness.statuses.at(-1) === "xper offline");
  assert.match(harness.status(), /bridge offline/);
  await harness.emit("session_shutdown");
  await harness.emit("session_start");
  assert.match(harness.status(), /bridge connected/);
  await harness.emit("session_shutdown");
});

test("missing bridge binary gives an actionable error without failing session startup", async () => {
  const harness = fakePi();
  createXperExtension(harness.pi, { command: resolve(workspace, "missing-xper-binary") });
  await harness.emit("session_start");
  assert.match(harness.status(), /binary not found.*cargo build -p xper-cli/);
  await harness.emit("session_shutdown");
});

test("incompatible bridge gives rebuild guidance", async () => {
  const harness = fakePi();
  const reply = `process.stdin.once("data", () => process.stdout.write(JSON.stringify({jsonrpc:"2.0",protocolVersion:"1",id:"adapter-1",result:{protocolVersion:"2",bridgeVersion:"old"}})+"\\n"))`;
  createXperExtension(harness.pi, { command: process.execPath, args: ["-e", reply] });
  await harness.emit("session_start");
  assert.match(harness.status(), /incompatible xper bridge.*Rebuild xper/);
  await harness.emit("session_shutdown");
});

test("recognizes the failed subagent envelope observed in XP-001", () => {
  assert.equal(
    isPiToolError({
      toolName: "subagent",
      toolCallId: "call-1",
      isError: false,
      result: { details: { status: "error", isError: true, exitCode: 1 } },
    }),
    true,
  );
  assert.equal(
    isPiToolError({
      toolName: "subagent",
      toolCallId: "call-2",
      isError: false,
      result: { details: { status: "done", isError: false, exitCode: 0, output: "" } },
    }),
    false,
  );
});

test("records raw subagent signals without prompts or output", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-pi-observe-"));
  const journal = join(directory, "observations.jsonl");
  const harness = fakePi();
  createXperExtension(harness.pi, { command: binary, observationsFile: journal });
  try {
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("tool_execution_start", {
      toolName: "subagent",
      toolCallId: "call-error",
      args: { task: "secret prompt" },
    });
    await harness.emit("tool_execution_end", {
      toolName: "subagent",
      toolCallId: "call-error",
      isError: false,
      result: {
        details: { status: "error", isError: true, exitCode: 1, output: "secret output" },
      },
    });
    await harness.emit("tool_execution_start", {
      toolName: "subagent",
      toolCallId: "call-done",
    });
    await harness.emit("tool_execution_end", {
      toolName: "subagent",
      toolCallId: "call-done",
      isError: false,
      result: { details: { status: "done", isError: false, exitCode: 0, output: "secret" } },
    });
    assert.match(harness.status(), /reported done 1, reported error 1/);
    assert.match(harness.status(), /mismatches 1/);
    await harness.emit("session_shutdown", { reason: "quit" });
    const text = readFileSync(journal, "utf8");
    assert.doesNotMatch(text, /secret/);
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      rows.some((row) => row.type === "session.start" && row.testedOpenAgentsVersion === "0.1.22"),
    );
    assert(rows.some((row) => row.type === "bridge.connected"));
    assert(rows.some((row) => row.type === "command.invoked" && row.recognized === true));
    assert(rows.some((row) => row.type === "session.end" && row.reportedDone === 1));
    assert(rows.some((row) => row.type === "subagent.end" && row.reportedStatus === "error"));
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
      assert.match(await harness.command("start Explore this project"), /"phase":"discovery"/);
      assert.match(await harness.command("advance"), /"advanced":false/);
      if (scenario === "succeeded") {
        await harness.emit("session_shutdown");
        await harness.emit("session_start");
        assert.match(harness.status(), /phase discovery/);
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
      const status = JSON.parse(
        execFileSync(binary, ["status", "--json"], { cwd, encoding: "utf8" }),
      ) as {
        run: {
          visits: Array<{ phase: string }>;
          attempts: Record<string, { outcome: string }>;
          artifacts: Record<string, unknown>;
        };
        timeline: Array<{ kind: { type: string; outcome?: string; phase?: string } }>;
      };
      const run = status.run;
      assert.equal(run.visits.at(-1)?.phase, scenario === "succeeded" ? "define" : "discovery");
      assert.equal(Object.values(run.attempts)[0]?.outcome, scenario);
      assert.equal(
        status.timeline.filter((event) => event.kind.type === "attempt_finished").length,
        1,
      );
      assert.equal(Object.values(run.artifacts).length, scenario === "succeeded" ? 1 : 0);
      assert.match(harness.status(), new RegExp(`attempts ${scenario}`));
      if (scenario === "succeeded") {
        assert(status.timeline.some((event) => event.kind.type === "artifact_registered"));
        assert(
          status.timeline.some(
            (event) => event.kind.type === "gate_evaluated" && event.kind.outcome === "failed",
          ),
        );
        assert(
          status.timeline.some(
            (event) => event.kind.type === "phase_entered" && event.kind.phase === "define",
          ),
        );
        assert.doesNotMatch(JSON.stringify(status.timeline), /inspect evidence|Evidence found/);
        await harness.emit("session_shutdown");
        await harness.emit("session_start");
        assert.match(harness.status(), /phase define/);
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
      assert.equal(correlated?.attemptId, Object.keys(run.attempts)[0]);
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
  try {
    const first = await connectBridge(manifest, { command: binary });
    await first.client.request("session.attach", { sessionId: "s1", cwd: directory, mode: "rpc" });
    await first.client.request("run.start", { objective: "retry after interruption" });
    const assigned = await first.client.request("assignment.start");
    const closed = new Promise<void>((resolve) =>
      first.client.process.once("close", () => resolve()),
    );
    first.client.close();
    await closed;
    // Advance the dead bridge's lease without waiting for the real 30-second timeout.
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE coordinator_leases SET expires_at_ms=0'); db.commit()",
      join(directory, ".xper", "events.sqlite"),
    ]);
    const second = await connectBridge(manifest, { command: binary });
    try {
      await second.client.request("session.attach", {
        sessionId: "s1",
        cwd: directory,
        mode: "rpc",
      });
      const recovered = await second.client.request("run.status");
      const projection = recovered.run as { attempts: Record<string, { outcome: string }> };
      assert.equal(projection.attempts[assigned.attemptId as string]?.outcome, "interrupted");
      const retry = await second.client.request("assignment.start", {
        assignmentId: assigned.assignmentId,
      });
      assert.equal(retry.assignmentId, assigned.assignmentId);
      assert.notEqual(retry.attemptId, assigned.attemptId);
      await second.client.request("attempt.finish", {
        attemptId: retry.attemptId,
        outcome: "failed",
      });
      const status = await second.client.request("run.status");
      assert.equal(
        (status.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
        "discovery",
      );
    } finally {
      await second.client.shutdown();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two Pi sessions stay isolated while one run has parallel delegations", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const directory = mkdtempSync(join(tmpdir(), "xper-concurrent-"));
  const manifest = { adapter: "pi", adapterVersion: "0.1.0", capabilities: { subagents: true } };
  const first = await connectBridge(manifest, { command: binary });
  const second = await connectBridge(manifest, { command: binary });
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
      first.client.request("run.start", { objective: "first" }),
      second.client.request("run.start", { objective: "second" }),
    ]);
    assert.notEqual(one.runId, two.runId);
    const [statusOne, statusTwo] = await Promise.all([
      first.client.request("run.status"),
      second.client.request("run.status"),
    ]);
    assert.equal((statusOne.run as { run_id: string }).run_id, one.runId);
    assert.equal((statusTwo.run as { run_id: string }).run_id, two.runId);
    const inspected = JSON.parse(
      execFileSync(binary, ["status", "--json", "--run", one.runId as string], {
        cwd: directory,
        encoding: "utf8",
      }),
    ) as { run: { run_id: string } };
    assert.equal(inspected.run.run_id, one.runId);

    await assert.rejects(
      second.client.request("run.join", { runId: one.runId }),
      /method not found/,
    );
    const [assignmentOne, assignmentTwo, otherSessionAssignment] = await Promise.all([
      first.client.request("assignment.start"),
      first.client.request("assignment.start"),
      second.client.request("assignment.start"),
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
    await first.client.request("attempt.finish", {
      attemptId: assignmentOne.attemptId,
      outcome: "succeeded",
      artifactPath: brief,
    });
    const waiting = await first.client.request("run.advance");
    assert.equal(waiting.advanced, false);
    assert.match(waiting.reason as string, /still running/);
    await first.client.request("attempt.finish", {
      attemptId: assignmentTwo.attemptId,
      outcome: "failed",
    });
    const advanced = await first.client.request("run.advance");
    assert.equal(advanced.advanced, true);
    const isolated = await first.client.request("run.status");
    assert.equal(
      (isolated.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
      "define",
    );
    assert.equal(Object.keys((isolated.run as { attempts: object }).attempts).length, 2);
    const otherSessionStatus = await second.client.request("run.status");
    assert.equal((otherSessionStatus.run as { run_id: string }).run_id, two.runId);
    assert.equal(
      (otherSessionStatus.run as { visits: Array<{ phase: string }> }).visits.at(-1)?.phase,
      "discovery",
    );
    assert.equal(Object.keys((otherSessionStatus.run as { attempts: object }).attempts).length, 1);
  } finally {
    await Promise.allSettled([first.client.shutdown(), second.client.shutdown()]);
    rmSync(directory, { recursive: true, force: true });
  }
});
