import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectBridge } from "../bridge/client.js";
import { PiWorkflow } from "../workflow/controller.js";
import { XperClient } from "../bridge/xper-client.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");
const manifest = {
  adapter: "pi",
  adapterVersion: "0.1.0",
  capabilities: { subagents: true, parallelSubagents: false },
};

test("bridge records one routed attempt and its selection", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const root = await mkdtemp(join(tmpdir(), "xper-routing-"));
  const previousHome = process.env.HOME;
  await mkdir(join(root, "home"));
  await mkdir(join(root, ".xper"));
  await writeFile(
    join(root, ".xper", "config.yaml"),
    JSON.stringify({
      profile: "work",
      contexts: {
        company: { allowed_providers: ["corp"] },
      },
      profiles: {
        work: {
          context: "company",
          roles: {
            "discovery.explorer": {
              provider: "corp",
              model: "m1",
              thinking: "low",
            },
          },
        },
      },
    }),
  );
  process.env.HOME = join(root, "home");
  let client: Awaited<ReturnType<typeof connectBridge>>["client"] | undefined;
  try {
    ({ client } = await connectBridge(manifest, { command: binary }));
    await client.request("session.attach", {
      sessionId: "routing-session",
      cwd: root,
      mode: "rpc",
    });
    const recorder = new XperClient(client);
    const routing = await recorder.inspectProfile();
    assert.equal(routing?.routes["discovery.explorer"]?.[0]?.model, "m1");
    await assert.rejects(recorder.resolveConfiguration([]));
    const configuration = await recorder.resolveConfiguration([
      { provider: "corp", model: "m1", reasoning: true },
    ]);
    const workflow = new PiWorkflow(recorder, root, "routing-session", {
      configuration: () => configuration,
    });
    const started = await workflow.startRun("Investigate");
    const first = await workflow.startAssignment();
    assert.equal(first.selection?.model, "m1");
    await workflow.finishAttempt({ attemptId: first.attemptId, outcome: "failed" });
    await assert.rejects(workflow.startAssignment(first.assignmentId));
    const status = await workflow.getRunStatus();
    const run = status.run as unknown as Record<string, unknown>;
    assert.equal(run.run_id, started.runId);
    const savedRouting = run.routing as Record<string, unknown>;
    assert.equal(savedRouting.profile, "work");
    const persistedAttempts = run.attempts as Record<
      string,
      { selection: { provider: string; model: string; thinking: string } }
    >;
    assert.deepEqual(persistedAttempts[first.attemptId]?.selection, first.selection);
    assert.equal(Object.keys(persistedAttempts).length, 1);
    await workflow.waitForRecording();
    workflow.stopRecording();
    await client.shutdown();
    client = undefined;
    ({ client } = await connectBridge(manifest, { command: binary }));
    await client.request("session.attach", {
      sessionId: "routing-session",
      cwd: root,
      mode: "rpc",
    });
    const restored = new PiWorkflow(new XperClient(client), root, "routing-session");
    const reopened = await restored.getRunStatus();
    await restored.waitForRecording();
    restored.stopRecording();
    const history = (reopened.run as unknown as Record<string, unknown>).attempts as Record<
      string,
      { selection: unknown }
    >;
    assert.deepEqual(history[first.attemptId]?.selection, first.selection);
  } finally {
    if (client) {
      await client.shutdown().catch(() => client?.close());
      client.close();
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
