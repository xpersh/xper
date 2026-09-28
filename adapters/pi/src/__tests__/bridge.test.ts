import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { connectBridge } from "../bridge/client.js";
import { ProtocolFailure, errorCode } from "../bridge/protocol.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");
const manifest = {
  adapter: "pi",
  adapterVersion: "0.1.0",
  capabilities: { subagents: true, parallelSubagents: false },
};

function buildBridge(): void {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
}

test("TypeScript and Rust complete a bidirectional handshake and restart", async () => {
  buildBridge();
  for (let attempt = 0; attempt < 2; attempt++) {
    const directory = mkdtempSync(join(tmpdir(), "xper-bridge-"));
    const { client, handshake } = await connectBridge(manifest, { command: binary });
    try {
      assert.equal(handshake.protocolVersion, "1");
      assert.equal(handshake.bridgeVersion, "0.1.0");
      assert.equal(handshake.capabilities.bidirectionalRequests, true);
      assert.equal(handshake.capabilities.eventRecording, true);
      assert.equal(handshake.capabilities.configurationResolution, true);
      assert.equal(handshake.maxFrameBytes, 65_536);
      assert.deepEqual(await client.request("ping"), { pong: true });
      assert.deepEqual(
        await client.request("session.attach", {
          sessionId: "pi-session",
          cwd: directory,
          mode: "rpc",
        }),
        { attached: true },
      );
      assert.deepEqual(
        await client.request("event.ingest", {
          sessionId: "pi-session",
          kind: "error",
          source: "tool:bash",
          toolCallId: "call-1",
        }),
        { accepted: true },
      );
      await assert.rejects(
        client.request("session.detach", { sessionId: "other-session" }),
        (error: unknown) =>
          error instanceof ProtocolFailure && error.code === errorCode.invalidParams,
      );
      assert.deepEqual(await client.request("session.detach", { sessionId: "pi-session" }), {
        detached: true,
      });
      await assert.rejects(
        client.request("unrecognized.method"),
        (error: unknown) =>
          error instanceof ProtocolFailure && error.code === errorCode.methodNotFound,
      );
      await assert.rejects(
        client.request("ping", { unexpected: true }),
        (error: unknown) =>
          error instanceof ProtocolFailure && error.code === errorCode.invalidParams,
      );
      await client.shutdown();
      await client.shutdown();
    } finally {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("malformed, oversized, and incompatible frames fail without corrupting the stream", async () => {
  buildBridge();
  const child = spawn(binary, ["bridge", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  async function exchange(frame: string): Promise<Record<string, unknown>> {
    child.stdin.write(`${frame}\n`);
    const next = await lines.next();
    assert.equal(next.done, false);
    return JSON.parse(next.value) as Record<string, unknown>;
  }
  try {
    let reply = await exchange("{");
    assert.deepEqual(reply.error, { code: errorCode.parseError, message: "invalid JSON" });
    reply = await exchange("x".repeat(65_537));
    assert.deepEqual(reply.error, { code: errorCode.frameTooLarge, message: "frame too large" });
    reply = await exchange(
      JSON.stringify({
        jsonrpc: "2.0",
        protocolVersion: "2",
        id: "a",
        method: "ping",
        params: {},
      }),
    );
    assert.equal((reply.error as { code: number }).code, errorCode.incompatibleVersion);
    assert.equal(reply.id, "a");
    reply = await exchange(
      JSON.stringify({
        jsonrpc: "2.0",
        protocolVersion: "1",
        id: "b",
        method: "ping",
        params: {},
      }),
    );
    assert.equal((reply.error as { code: number }).code, errorCode.notInitialized);
    reply = await exchange(
      JSON.stringify({
        jsonrpc: "2.0",
        protocolVersion: "1",
        id: "c",
        method: "shutdown",
        params: {},
      }),
    );
    assert.deepEqual(reply.result, { ok: true });
    assert.deepEqual(await closed, [0, null]);
  } finally {
    child.kill();
  }
});

test("an unresponsive child produces a request timeout", async () => {
  await assert.rejects(
    connectBridge(manifest, {
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      requestTimeoutMs: 50,
    }),
    (error: unknown) => error instanceof ProtocolFailure && error.code === errorCode.timeout,
  );
});
