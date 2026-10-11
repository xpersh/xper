import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterPackage,
  PiWorkflow,
  BridgeClient,
  knowledgeDefinition,
  createXperExtension,
} from "@xper/adapter-pi";
import { XperWorkflow } from "@xper/adapter-shared/workflow";
import { BridgeClient as SharedBridgeClient } from "@xper/adapter-shared/bridge";
import { toolsForRole } from "../execution/roles.js";
import { PreparedConfiguration } from "../pi/configuration.js";

test("declares a public-protocol adapter boundary", () => {
  assert.deepEqual(adapterPackage, {
    harness: "pi",
    packageName: "@xper/adapter-pi",
    protocolBoundary: "public",
  });
});

test("public Pi exports retain the constructor, native tools and local storage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-pi-public-"));
  const recorder = {
    async appendEvents() {
      return { accepted: 0, durability: "persistent" as const };
    },
  };
  const workflow = new PiWorkflow(recorder, cwd, "public-session");
  try {
    assert(workflow instanceof XperWorkflow);
    assert.equal(BridgeClient, SharedBridgeClient);
    assert.equal(typeof createXperExtension, "function");
    assert.equal(knowledgeDefinition.id, "xper.knowledge");
    assert.deepEqual(toolsForRole("implementation.driver"), ["read", "bash", "edit", "write"]);
    assert.deepEqual(toolsForRole("verify.verifier"), ["read", "bash"]);
    assert.deepEqual(toolsForRole("judgment_day.judge"), ["read"]);
    const run = await workflow.startRun("Public Pi API");
    await workflow.waitForRecording();
    const key = createHash("sha256").update("public-session").digest("hex");
    assert((await readFile(join(cwd, ".xper", "pi", `${key}.json`), "utf8")).includes(run.runId));
    const cache = new PreparedConfiguration(cwd);
    assert.equal(cache.path, join(cwd, ".xper", "pi", "configuration.json"));
    assert.match(cache.summary(), /Pi defaults/);
  } finally {
    await workflow.stopRecording();
    await rm(cwd, { recursive: true, force: true });
  }
});
