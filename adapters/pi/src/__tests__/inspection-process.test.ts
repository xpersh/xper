import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { InspectionResponse } from "../inspection/protocol.js";

const helper = fileURLToPath(new URL("../inspection/cli.js", import.meta.url));

async function harness(source: string) {
  const root = await mkdtemp(join(tmpdir(), "xper-inspection-"));
  const fake = join(root, "pi-fake");
  await writeFile(fake, `#!${process.execPath}\n${source}`);
  await chmod(fake, 0o755);
  const child = spawn(process.execPath, [helper], {
    cwd: root,
    env: { ...process.env, XPER_PI_COMMAND: fake, XPER_TEST_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  const exit = once(child, "exit");
  const receive = async (): Promise<InspectionResponse> => {
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
    return JSON.parse(String(line)) as InspectionResponse;
  };
  let id = 0;
  return {
    root,
    child,
    exit,
    stderr: () => stderr,
    async query(method: string, params?: Record<string, unknown>) {
      const response = receive();
      child.stdin.write(
        `${JSON.stringify({ schemaVersion: 1, id: String(++id), method, ...(params ? { params } : {}) })}\n`,
      );
      return response;
    },
    async raw(value: string) {
      const response = receive();
      child.stdin.write(value);
      return response;
    },
    async cleanup() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exit;
      clearTimeout(timer);
      lines.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("helper uses one Pi catalog across searches, refreshes explicitly, and keeps stdout framed", async () => {
  const h = await harness(`
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.env.XPER_TEST_ROOT, 'calls'), 'call\\n');
console.error('synthetic-test-secret');
console.log('provider model context max-out thinking images\\ncorp fast 128K 16K no no\\ncorp reasoner 128K 16K yes no');
`);
  try {
    const described = await h.query("describe");
    assert("result" in described && "roles" in described.result);
    const result = await h.query("models");
    assert("result" in result && "models" in result.result);
    assert.equal(result.result.models.length, 2);
    const searched = await h.query("search", { query: "rsnr" });
    assert("result" in searched && "models" in searched.result);
    assert.equal(searched.result.models[0]?.model, "reasoner");
    assert.equal(await readFile(join(h.root, "calls"), "utf8"), "call\n");
    await h.query("refresh");
    assert.equal(await readFile(join(h.root, "calls"), "utf8"), "call\ncall\n");
    assert.equal(h.stderr(), "");
  } finally {
    await h.cleanup();
  }
});

test("helper rejects bad JSON and oversized frames and recovers for the next request", async () => {
  const h = await harness("process.exit(99);");
  try {
    const bad = await h.raw("{bad}\n");
    assert("error" in bad && bad.error.code === "INVALID_REQUEST");
    const large = await h.raw(`${"x".repeat(1_048_577)}\n`);
    assert("error" in large && large.error.code === "INVALID_REQUEST");
    const valid = await h.query("describe");
    assert("result" in valid);
    const unavailable = await h.query("models");
    assert("error" in unavailable && unavailable.error.code === "CATALOG_UNAVAILABLE");
  } finally {
    await h.cleanup();
  }
});

test("closing the helper cancels an outstanding Pi catalog child", async () => {
  const h = await harness(`
require('node:fs').writeFileSync(require('node:path').join(process.env.XPER_TEST_ROOT, 'pid'), String(process.pid));
setInterval(() => {}, 1000);
`);
  try {
    h.child.stdin.write('{"schemaVersion":1,"id":"pending","method":"models"}\n');
    let pid: number | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !pid) {
      try {
        pid = Number(await readFile(join(h.root, "pid"), "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(pid, "Pi catalog child started");
    h.child.stdin.end();
    const [code] = await Promise.race([
      h.exit,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not exit after EOF")), 1000);
        timer.unref();
      }),
    ]);
    assert.equal(code, 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await h.cleanup();
  }
});

test("oversized catalog responses return a bounded error and keep inspection usable", async () => {
  const h = await harness(`
console.log('provider model context max-out thinking images');
for (let index = 0; index < 18000; index++) console.log('example model-' + index + ' 128K 16K yes no');
`);
  try {
    const response = await h.query("models");
    assert("error" in response && response.error.code === "RESPONSE_TOO_LARGE");
    assert("result" in (await h.query("describe")));
    const search = await h.query("search", { query: "model-17999" });
    assert("result" in search && "models" in search.result);
    assert.equal(search.result.models[0]?.model, "model-17999");
  } finally {
    await h.cleanup();
  }
});
