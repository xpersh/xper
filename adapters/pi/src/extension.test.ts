import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXperExtension, isPiToolError } from "./extension.js";
import { PiObservations } from "./observations.js";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
  let command: ((args: string, ctx: unknown) => void) | undefined;
  const ctx = {
    cwd: workspace,
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
