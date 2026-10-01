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
import { createXperExtension } from "../extension.js";
import { XperSession } from "../pi/session.js";
import { binary, fakePi, pidFrom, until, workspace } from "./extension-harness.js";

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
