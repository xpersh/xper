import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilitiesForRole, knowledgeDefinition } from "@xper/adapter-shared";
import type { RecordedEvent } from "@xper/adapter-shared/bridge";
import { PreparedConfiguration } from "@xper/adapter-shared/configuration";
import { XperWorkflow } from "@xper/adapter-shared/workflow";

test("public shared runtime isolates two harnesses with the same session and retains cost provenance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-shared-consumer-"));
  const events: RecordedEvent[] = [];
  const recorder = {
    async appendEvents(batch: RecordedEvent[]) {
      events.push(...structuredClone(batch));
      return { accepted: batch.length, durability: "persistent" as const };
    },
  };
  const first = new XperWorkflow(recorder, cwd, "same-session", { adapterId: "synthetic" });
  const second = new XperWorkflow(recorder, cwd, "same-session", { adapterId: "another" });
  const controllers = [first, second];
  try {
    const run = await first.startRun("First objective");
    assert.equal((await second.getRunStatus()).run, null);
    const other = await second.startRun("Second objective");
    assert.notEqual(run.runId, other.runId);
    const attempt = await first.startAssignment();
    await first.recordUsage(attempt.attemptId, { costMicros: 7, costSource: "synthetic_estimate" });
    await first.finishAttempt({ attemptId: attempt.attemptId, outcome: "failed" });
    await Promise.all(controllers.map((controller) => controller.waitForRecording()));
    for (const [runId, adapter] of [
      [run.runId, "synthetic"],
      [other.runId, "another"],
    ]) {
      const checkpoints = events.filter(
        (event) => event.runId === runId && event.type === "adapter.state",
      );
      assert(checkpoints.length > 0);
      assert(checkpoints.every((event) => event.data.adapter === adapter));
      const definition = events.find(
        (event) => event.runId === runId && event.type === "workflow.definition",
      );
      assert.deepEqual(definition?.data.definition, knowledgeDefinition);
    }
    assert(
      events.some(
        (event) => event.type === "model.usage" && event.data.costSource === "synthetic_estimate",
      ),
    );
    const key = createHash("sha256").update("same-session").digest("hex");
    const saved = await readFile(join(cwd, ".xper", "synthetic", `${key}.json`), "utf8");
    assert(saved.includes(run.runId));
    assert(!saved.includes(other.runId));
    await first.stopRecording();
    const restored = new XperWorkflow(recorder, cwd, "same-session", { adapterId: "synthetic" });
    controllers.push(restored);
    assert.equal((await restored.getRunStatus()).run?.run_id, run.runId);
    const cache = new PreparedConfiguration(cwd, "synthetic");
    await cache.update({ routing: null, adapterConfig: { source: "synthetic" } });
    const otherCache = new PreparedConfiguration(cwd, "another");
    await otherCache.load();
    assert.equal(otherCache.snapshot, null);
    const restoredCache = new PreparedConfiguration(cwd, "synthetic");
    await restoredCache.load();
    assert.deepEqual(restoredCache.snapshot, cache.snapshot);
    assert.equal(restoredCache.source, "cached");
    assert.throws(() => new PreparedConfiguration(cwd, "../escape"), /adapter ID/);
    assert.throws(
      () => new XperWorkflow(recorder, cwd, "session", { adapterId: "../escape" }),
      /adapter ID/,
    );
  } finally {
    await Promise.all(controllers.map((controller) => controller.stopRecording()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shared role capabilities express workflow permissions independently of native tools", () => {
  assert.deepEqual(capabilitiesForRole("judgment_day.judge"), ["read"]);
  assert.deepEqual(capabilitiesForRole("verify.verifier"), ["read", "command"]);
  assert.deepEqual(capabilitiesForRole("implementation.driver"), ["read", "command", "modify"]);
  assert.throws(() => capabilitiesForRole("unknown.role"), /Unsupported/);
});
