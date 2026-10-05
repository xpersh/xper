import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAvailableModels, parseAvailableModels, piModelOptions } from "../execution/models.js";

test("Pi catalog distinguishes empty results from malformed output", () => {
  assert.deepEqual(parseAvailableModels("No models available. Configure credentials in Pi.\n"), []);
  assert.deepEqual(parseAvailableModels('No models matching "xyz"\n'), []);
  assert.throws(() => parseAvailableModels(""), /unrecognized format/);
  assert.throws(
    () => parseAvailableModels("provider model context max-out thinking images\ncorp incomplete\n"),
    /incomplete/,
  );
  assert.throws(
    () =>
      parseAvailableModels(
        "provider model context max-out thinking images\ncorp m1 128K 16K maybe no\n",
      ),
    /invalid/,
  );
});

test("Pi catalog timeout is bounded and never returns child diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-model-timeout-"));
  const script = join(directory, "pi-fake");
  await writeFile(
    script,
    `#!${process.execPath}\nconsole.error('synthetic-test-secret'); setInterval(() => {}, 1000);\n`,
  );
  await chmod(script, 0o755);
  const previous = process.env.XPER_PI_COMMAND;
  process.env.XPER_PI_COMMAND = script;
  try {
    await assert.rejects(listAvailableModels({ timeoutMs: 150 }), (error: unknown) => {
      assert(error instanceof Error && "code" in error);
      assert.equal(error.code, "CATALOG_TIMEOUT");
      assert(!error.message.includes("synthetic-test-secret"));
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.XPER_PI_COMMAND;
    else process.env.XPER_PI_COMMAND = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi catalog and execution use the shared Pi provider configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-models-"));
  const script = join(directory, "pi-fake");
  await writeFile(
    script,
    '#!/bin/sh\nif [ "$OPENAI_API_KEY" != "fake-test-secret" ]; then exit 42; fi\nprintf \'provider  model  context  max-out  thinking  images\\ncorp  m1  128K  16K  yes  no\\ncorp  m2  128K  16K  no  no\\n\'\n',
  );
  await chmod(script, 0o755);
  const previousCommand = process.env.XPER_PI_COMMAND;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.XPER_PI_COMMAND = script;
  process.env.OPENAI_API_KEY = "fake-test-secret";
  try {
    assert.deepEqual(await listAvailableModels(), [
      { provider: "corp", model: "m1", reasoning: true },
      { provider: "corp", model: "m2", reasoning: false },
    ]);
    const options = piModelOptions({
      context: "company",
      provider: "corp",
      model: "m1",
      thinking: "high",
    });
    assert.equal(options.model, "corp/m1");
    assert.equal(options.thinking, "high");
  } finally {
    if (previousCommand === undefined) delete process.env.XPER_PI_COMMAND;
    else process.env.XPER_PI_COMMAND = previousCommand;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
