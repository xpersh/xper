import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { delegateKnowledge } from "../actions/delegate-knowledge.js";
import { connectBridge, type BridgeClient } from "../bridge/client.js";
import { PiWorkflow } from "../workflow/controller.js";
import { XperClient } from "../bridge/xper-client.js";
import { saveArtifact } from "../knowledge/artifacts.js";
import { resolveAgent } from "../knowledge/delegate.js";
import { knowledgeDefinition } from "../workflow/definition.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(workspace, "fixtures/knowledge-v1.json"), "utf8"),
) as Array<{ phase: string; artifact: { output: unknown } }>;
const manifest = {
  adapter: "fake",
  adapterVersion: "1",
  capabilities: { subagents: true, humanApproval: true },
};

test("all phases run through the public bridge with fake execution, durable approval, and a ready Plan", async () => {
  execFileSync("cargo", ["build", "--quiet", "-p", "xper-cli"], { cwd: workspace });
  const root = await mkdtemp(join(tmpdir(), "xper-knowledge-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  await mkdir(process.env.HOME);
  await mkdir(join(root, ".xper"));
  await writeFile(
    join(root, ".xper/config.yaml"),
    JSON.stringify({ workflow: { knowledge: { humanGates: ["define"] } } }),
  );
  let bridge: BridgeClient | undefined;
  const connect = async () => {
    ({ client: bridge } = await connectBridge(manifest, {
      command: resolve(workspace, "target/debug/xper"),
    }));
    await bridge.request("session.attach", { sessionId: "knowledge-test", cwd: root, mode: "rpc" });
    const recorder = new XperClient(bridge);
    const configuration = await recorder.resolveConfiguration();
    return new PiWorkflow(recorder, root, "knowledge-test", { configuration: () => configuration });
  };
  try {
    let client = await connect();
    await client.startRun("Synthetic knowledge workflow");
    let expectedInputs = 0;
    for (const phase of ["discovery", "define", "design", "breakdown", "plan"]) {
      if (phase === "define") {
        const rejected = await delegateKnowledge(
          { task: "Synthetic malformed output", cwd: root, signal: new AbortController().signal },
          {
            workflow: client,
            execute: async () => ({ outcome: "succeeded", brief: '{"invalid":"document"}' }),
            saveBrief: saveArtifact,
          },
        );
        assert.equal(rejected.outcome, "failed");
        assert.match(rejected.reason ?? "", /structured phase artifact required/);
        assert.equal(rejected.artifactId, null);
      }
      const result = await delegateKnowledge(
        { task: "Use the supplied artifacts", cwd: root, signal: new AbortController().signal },
        {
          workflow: client,
          execute: async (request) => {
            assert.equal(request.role.split(".")[0], phase);
            assert.equal(request.inputArtifacts?.length, expectedInputs);
            assert(request.timeoutMs <= 120000);
            assert(
              resolveAgent(request.role).systemPrompt.includes("do not implement") ||
                resolveAgent(request.role).systemPrompt.includes("Do not implement"),
            );
            const brief =
              phase === "discovery"
                ? "# Discovery Brief\nSynthetic evidence"
                : JSON.stringify({
                    schemaVersion: 1,
                    inputs: request.inputArtifacts?.map((input) => input.artifact_id),
                    output: fixtures.find((fixture) => fixture.phase === phase)?.artifact.output,
                  });
            return { outcome: "succeeded", brief };
          },
          saveBrief: saveArtifact,
        },
      );
      assert.equal(result.outcome, "succeeded");
      assert(result.artifactId);
      expectedInputs++;
      if (phase === "define") {
        assert.equal(result.gate?.advanced, false);
        assert.equal(result.gate?.humanArtifactId, result.artifactId);
        await client.waitForRecording();
        client.stopRecording();
        await bridge?.shutdown();
        bridge = undefined;
        client = await connect();
        assert.equal((await client.startRun("Resume")).resumed, true);
        await assert.rejects(client.advanceRun("wrong-artifact"));
        assert.equal((await client.advanceRun(result.artifactId)).phase, "design");
      } else {
        assert.equal(result.gate?.advanced, true);
      }
      if (phase === "plan") assert.equal(result.gate?.ready, true);
    }
    const before = await client.getRunStatus();
    assert.equal(Object.keys(before.run?.attempts ?? {}).length, 6);
    assert.equal(Object.keys(before.run?.artifacts ?? {}).length, 5);
    assert.equal(before.workflow?.nodeId, "ready");
    assert.equal(before.workflow?.status, "completed");
    assert.notEqual(before.workflow?.instanceId, before.run?.run_id);
    assert(!JSON.stringify(before.timeline).includes("Given a name"));
    await client.waitForRecording();
    assert(bridge);
    const recorded = await new XperClient(bridge).getRunStatus(before.run?.run_id);
    const definitions = recorded.timeline.filter((event) => event.type === "workflow.definition");
    assert.equal(definitions.length, 2, "reloading repeats the same immutable definition");
    for (const event of definitions) assert.deepEqual(event.data.definition, knowledgeDefinition);
    const transitions = recorded.timeline.filter((event) => event.type === "workflow.transition");
    assert.deepEqual(
      transitions.map((event) => event.data.transitionId),
      [
        "gate.discovery.define",
        "gate.define.design",
        "gate.design.breakdown",
        "gate.breakdown.plan",
        "gate.plan.ready",
      ],
    );
    for (const event of recorded.timeline) {
      assert.equal(event.runId, before.run?.run_id);
      assert.equal(event.data.instanceId, before.workflow?.instanceId);
      assert.equal(event.data.definitionId, knowledgeDefinition.id);
      assert.equal(event.data.definitionVersion, knowledgeDefinition.version);
    }
    assert.deepEqual(
      recorded.timeline.filter((event) => event.type === "workflow.position").at(-1)?.data,
      before.workflow,
    );
    assert.equal(
      recorded.timeline.filter((event) => event.type === "workflow.completed").length,
      1,
    );
    assert(!recorded.timeline.some((event) => event.type === "run.completed"));
    const checkpoint = recorded.timeline.findLast((event) => event.type === "adapter.state")?.data
      .state as Record<string, unknown>;
    assert.equal(checkpoint.version, 3);
    const knowledge = checkpoint.knowledge as Record<string, unknown>;
    assert.equal(knowledge.instanceId, before.workflow?.instanceId);
    assert.equal(Object.hasOwn(knowledge, "ready"), false);
    client.stopRecording();
    await bridge?.shutdown();
    bridge = undefined;
    client = await connect();
    assert.deepEqual((await client.getRunStatus()).run, before.run);
    assert.equal((await client.advanceRun()).ready, true);
    await assert.rejects(client.startAssignment(), /Git checkout/);
    await client.waitForRecording();
    client.stopRecording();
  } finally {
    if (bridge) await bridge.shutdown().catch(() => bridge?.close());
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
