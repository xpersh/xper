import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createXperExtension } from "../extension.js";
import { binary, fakePi } from "./extension-harness.js";

test("xper starts and resumes without an agent manager, with an objective dialog or arguments", async () => {
  for (const invocation of ["", "Explore this project", "start Explore this project"]) {
    const directory = mkdtempSync(join(tmpdir(), "xper-command-"));
    const harness = fakePi(directory);
    harness.answers.push("Explore this project");
    createXperExtension(harness.pi, { command: binary });
    try {
      await harness.emit("session_start");
      await harness.connected();
      const started = await harness.command(invocation);
      assert.match(started, /Started workflow .*; phase discovery/);
      assert.match(started, /xper_delegate/);
      assert.equal(harness.prompts.length, invocation ? 0 : 1);
      const runId = started.match(/workflow ([^;]+);/)?.[1];
      assert(runId);
      const resumed = await harness.command("start Continue this project");
      assert(resumed.includes(`Resumed workflow ${runId}; phase discovery`));
      assert.match(await harness.status(), /phase discovery/);
    } finally {
      await harness.emit("session_shutdown");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("xper does not start a workflow after cancelled or invalid control input", async (t) => {
  for (const scenario of [
    "cancel",
    "empty",
    "no-ui",
    "help",
    "invalid-subcommand",
    "resume-without-commit",
  ] as const) {
    await t.test(scenario, async () => {
      const directory = mkdtempSync(join(tmpdir(), "xper-command-input-"));
      const harness = fakePi(directory);
      harness.ctx.hasUI = scenario !== "no-ui";
      harness.answers.push(scenario === "empty" ? "  " : undefined);
      createXperExtension(harness.pi, { command: binary });
      try {
        await harness.emit("session_start");
        await harness.connected();
        const result = await harness.command(
          scenario === "help"
            ? "help"
            : scenario === "invalid-subcommand"
              ? "advance extra"
              : scenario === "resume-without-commit"
                ? "resume"
                : "",
        );
        assert.match(await harness.status(), /no run/);
        assert.equal(harness.prompts.length, scenario === "cancel" || scenario === "empty" ? 1 : 0);
        if (scenario === "no-ui") assert.match(result, /Provide an objective/);
        if (scenario === "empty") assert.match(result, /objective is required/);
        if (scenario === "help" || scenario === "invalid-subcommand")
          assert.match(result, /Usage:/);
        if (scenario === "resume-without-commit")
          assert.match(result, /Provide the clean checkout/);
      } finally {
        await harness.emit("session_shutdown");
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
