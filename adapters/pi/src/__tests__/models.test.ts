import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAvailableModels, piModelOptions } from "../knowledge/models.js";

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
