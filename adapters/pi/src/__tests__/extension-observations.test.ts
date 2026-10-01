import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createXperExtension } from "../extension.js";
import { PiObservations } from "../pi/observations.js";
import { binary, fakePi, workspace } from "./extension-harness.js";

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
