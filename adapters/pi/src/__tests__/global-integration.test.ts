import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { binary } from "./extension-harness.js";

test("the generated global Pi integration resolves all profile roles from a foreign project", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "xper-global-integration-"));
  const home = join(root, "home");
  const piHome = join(home, ".pi/agent");
  const bin = join(root, "bin");
  const checkout = join(root, "checkout");
  const adapter = join(checkout, "adapters/pi");
  const foreign = join(root, "foreign-project");
  const calls = join(root, "pi-calls.txt");
  const configHome = join(home, ".config");
  const roles =
    "discovery.explorer define.product design.designer breakdown.slicer plan.planner implementation.driver verify.verifier judgment_day.judge".split(
      " ",
    );
  const selection = { provider: "example", model: "synthetic", thinking: "high" };
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
    PATH: bin,
    CATALOG_CALLS: calls,
  };
  try {
    for (const directory of [
      bin,
      foreign,
      piHome,
      join(configHome, "xper"),
      join(adapter, "dist/inspection"),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(adapter, "package.json"),
      JSON.stringify({ name: "@xper/adapter-pi", version: "0.1.0", type: "module" }),
    );
    writeFileSync(
      join(adapter, "dist/extension.js"),
      `export { createXperExtension } from ${JSON.stringify(new URL("../extension.js", import.meta.url).href)};\n`,
    );
    writeFileSync(
      join(adapter, "dist/inspection/cli.js"),
      "throw new Error('Inspection must not run during global setup');\n",
    );
    writeFileSync(
      join(bin, "pi"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CATALOG_CALLS"
case "$*" in
  --version) printf '0.87.1\\n' ;;
  '--offline --list-models') printf 'provider model context max-output reasoning images\\nexample synthetic 1000 1000 yes no\\n' ;;
  *) exit 91 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(configHome, "xper/config.yaml"),
      JSON.stringify({
        harness: { adapter: "pi" },
        profile: "global-test",
        contexts: { personal: { allowed_providers: ["example"] } },
        profiles: {
          "global-test": {
            context: "personal",
            roles: Object.fromEntries(roles.map((role) => [role, selection])),
          },
        },
      }),
    );
    execFileSync(binary, ["init", "--global", "--yes"], { cwd: checkout, env, timeout: 5_000 });
    const shim = join(piHome, "extensions/xper.ts");
    const source = readFileSync(shim, "utf8");
    assert(source.startsWith("// xper-managed-integration-v1 "));
    assert(source.includes(JSON.stringify(binary)));
    assert(!existsSync(join(bin, "xper")));
    const script = `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { fakePi, until } from ${JSON.stringify(new URL("./extension-harness.js", import.meta.url).href)};
      const { default: load } = await import(${JSON.stringify(pathToFileURL(shim).href)});
      assert(!existsSync('.pi'));
      assert.equal(process.env.XPER_BRIDGE_COMMAND, undefined);
      const harness = fakePi(process.cwd());
      load(harness.pi);
      let status = '';
      try {
        await harness.emit('session_start', { reason: 'startup' });
        await until(async () => {
          status = await harness.status();
          return status.includes('resolved configuration (profile global-test)');
        }, 5_000);
        assert.match(status, /; no run/);
        const cache = join('.xper', 'pi', 'configuration.json');
        await until(() => existsSync(cache));
        const { configuration } = JSON.parse(readFileSync(cache, 'utf8'));
        assert.equal(configuration.routing.profile, 'global-test');
        assert.deepEqual(Object.keys(configuration.routing.routes).sort(), ${JSON.stringify(roles)}.sort());
        for (const route of Object.values(configuration.routing.routes))
          assert.deepEqual(route, [{ ...${JSON.stringify(selection)}, context: 'personal' }]);
        assert.deepEqual(readdirSync('.xper/pi').filter(name => name.endsWith('.json')), ['configuration.json']);
        assert(!existsSync('.xper/artifacts'));
        assert(!existsSync('.pi'));
      } finally {
        await harness.emit('session_shutdown', { reason: 'shutdown' });
      }
    `;
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: foreign,
      env,
      timeout: 10_000,
    });
    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    assert(invocations.includes("--version"));
    assert(invocations.includes("--offline --list-models"));
    assert(invocations.every((args) => args === "--version" || args === "--offline --list-models"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
