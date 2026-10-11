import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { checkArchitecture, checkDependencies, moduleImports } from "./architecture.mjs";

const check = (files) => checkArchitecture(new Map(Object.entries(files)));
test("all workflow subdirectories inherit purity rules", () => {
  assert.match(
    check({ "workflow/knowledge/gate.ts": 'import { readFile } from "node:fs/promises";' }).join(
      "\n",
    ),
    /must remain pure/,
  );
  assert.match(
    check({ "workflow/delivery/select.ts": "const now = Date.now();" }).join("\n"),
    /explicit inputs/,
  );
});
test("re-exports cannot hide dependencies on effects", () => {
  assert.match(
    check({ "workflow/knowledge/state.ts": 'export * from "../runtime/evidence.js";' }).join("\n"),
    /must remain pure/,
  );
  assert.match(
    check({
      "workflow/knowledge/state.ts": 'export { XperClient } from "../../bridge/xper-client.js";',
    }).join("\n"),
    /must remain pure/,
  );
});
test("type-only protocol references stay available to pure decisions", () => {
  assert.deepEqual(
    check({
      "workflow/knowledge/state.ts":
        'import type { ModelSelection } from "../../bridge/xper-client.js";',
    }),
    [],
  );
  assert.equal(
    moduleImports("workflow/test.ts", 'export type { Value } from "./types.js";')[0].typeOnly,
    true,
  );
});
test("cycles include re-exports and type-only edges", () => {
  assert.match(
    check({
      "workflow/a.ts": 'export * from "./b.js";',
      "workflow/b.ts": 'import type { A } from "./a.js";',
    }).join("\n"),
    /Dependency cycle/,
  );
});
test("inline type specifiers and import-equals preserve their runtime dependency", () => {
  for (const source of [
    'import { type Stats } from "node:fs";',
    'export { type Stats } from "node:fs";',
    'import fs = require("node:fs");',
  ]) {
    assert.match(check({ "workflow/knowledge/state.ts": source }).join("\n"), /must remain pure/);
  }
  assert.deepEqual(
    check({
      "workflow/knowledge/state.ts": 'import type fs = require("node:fs");',
    }),
    [],
  );
});
test("actions cannot import concrete executors and bridge cannot depend on workflow", () => {
  assert.match(
    check({ "actions/delegate.ts": 'import { run } from "../execution/child.js";' }).join("\n"),
    /receive harness execution/,
  );
  assert.match(
    check({
      "bridge/client.ts": 'import { decide } from "../workflow/knowledge/machine.js";',
    }).join("\n"),
    /must not depend on workflow/,
  );
});
test("dynamic imports are included in dependency checks", () => {
  assert.match(
    check({ "workflow/knowledge/state.ts": 'const io = import("node:fs");' }).join("\n"),
    /must remain pure/,
  );
});
test("runtime encoding and journal storage stay within their boundaries", () => {
  assert.deepEqual(
    check({
      "workflow/runtime/events.ts": 'import { Buffer } from "node:buffer";',
      "workflow/journal.ts": 'import { readFile } from "node:fs/promises";',
    }),
    [],
  );
});

test("runtime preparation uses injected effects and execution cannot drive decisions", () => {
  assert.match(
    check({
      "workflow/runtime/start.ts": 'import { inspect } from "../../execution/workspace.js";',
    }).join("\n"),
    /runtime ports/,
  );
  assert.match(
    check({
      "execution/child.ts": 'import { transition } from "../workflow/knowledge/machine.js";',
    }).join("\n"),
    /not drive workflow decisions/,
  );
});
test("flows share contracts without importing each other’s transitions", () => {
  assert.match(
    check({
      "workflow/knowledge/gate.ts": 'import { transition } from "../verification/machine.js";',
    }).join("\n"),
    /compose other flows through delivery/,
  );
  assert.deepEqual(
    check({
      "workflow/implementation/state.ts":
        'import type { PlannedAssignment } from "../knowledge/contract.js";',
    }),
    [],
  );
});
test("actions cannot acquire I/O through a shared helper outside their dependency boundary", () => {
  assert.match(
    check({ "actions/delegate.ts": 'export * from "../shared/io.js";' }).join("\n"),
    /receive harness execution/,
  );
});

test("Judgment follows the same purity and cross-flow composition rules", () => {
  assert.match(
    check({
      "workflow/judgment/machine.ts": 'import { run } from "../../execution/child.js";',
    }).join("\n"),
    /must remain pure/,
  );
  assert.match(
    check({
      "workflow/judgment/machine.ts": 'import { transition } from "../verification/machine.js";',
    }).join("\n"),
    /compose other flows through delivery/,
  );
});

test("shared code rejects concrete adapter packages and SDKs, including type-only edges", () => {
  for (const dependency of [
    "@earendil-works/pi-tui",
    "@mariozechner/pi-coding-agent",
    "@opencode-ai/sdk",
    "@opencode-ai/plugin",
    "@xper/adapter-pi",
    "../../pi/src/pi/types.js",
  ])
    assert.match(
      check({ "storage.ts": `import type { Value } from "${dependency}";` }).join("\n"),
      /must not depend on a concrete adapter or harness/,
    );
  for (const dependency of ["@earendil-works/pi-tui", "@opencode-ai/sdk", "@xper/adapter-pi"])
    assert.match(checkDependencies([dependency]).join("\n"), /concrete harness/);
  assert.match(checkDependencies(["@xper/core"]).join("\n"), /private xper package/);
  assert.deepEqual(checkDependencies(["@xper/protocol"]), []);
});

test("the root public API and role metadata remain pure", () => {
  assert.deepEqual(
    check({
      "index.ts": 'export { knowledgeDefinition } from "./workflow/knowledge/definition.js";',
      "roles.ts": "export const role = 'discovery.explorer';",
      "role-descriptions.ts": 'import { role } from "./roles.js";',
    }),
    [],
  );
  for (const dependency of ["./workflow.js", "./bridge.js", "./configuration.js", "./storage.js"])
    assert.match(
      check({ "index.ts": `export * from "${dependency}";` }).join("\n"),
      /must remain pure/,
    );
  assert.match(check({ "roles.ts": "const now = Date.now();" }).join("\n"), /explicit inputs/);
});

test("public barrels cannot hide workflow policy from transport or execution", () => {
  for (const file of ["execution/runner.ts", "bridge/client.ts"])
    for (const dependency of ["../workflow.js", "../index.js"])
      assert.notDeepEqual(check({ [file]: `export * from "${dependency}";` }), []);
  assert.match(
    check({ "actions.ts": 'export * from "./execution/implementation.js";' }).join("\n"),
    /receive harness execution/,
  );
});

test("package self references resolve to source without generated declarations", () => {
  const directory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const config = ts.readConfigFile(`${directory}/tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const host = {
    ...ts.sys,
    fileExists: (file) => !file.replaceAll("\\", "/").includes("/dist/") && ts.sys.fileExists(file),
    directoryExists: (path) =>
      !/\/dist(?:\/|$)/.test(path.replaceAll("\\", "/")) && ts.sys.directoryExists(path),
  };
  for (const entry of ["index", "workflow", "actions", "execution", "bridge", "configuration"]) {
    const specifier = `@xper/adapter-shared${entry === "index" ? "" : `/${entry}`}`;
    const result = ts.resolveModuleName(
      specifier,
      `${directory}/src/__tests__/consumer.test.ts`,
      parsed.options,
      host,
      undefined,
      undefined,
      ts.ModuleKind.ESNext,
    );
    assert.equal(
      result.resolvedModule?.resolvedFileName.replaceAll("\\", "/"),
      `${directory}/src/${entry}.ts`.replaceAll("\\", "/"),
      specifier,
    );
  }
});

test("metadata barrels do not bypass workflow ownership or effect boundaries", () => {
  for (const dependency of ["../../index.js", "../../role-descriptions.js"])
    assert.match(
      check({
        "workflow/knowledge/machine.ts": `import { verificationDefinition } from "${dependency}";`,
      }).join("\n"),
      /without public metadata barrels/,
    );
  assert.match(
    check({
      "index.ts": 'export * from "./role-descriptions.js";',
      "role-descriptions.ts": 'export * from "./configuration.js";',
    }).join("\n"),
    /must remain pure/,
  );
  for (const file of ["execution/runner.ts", "bridge/client.ts"])
    assert.notDeepEqual(
      check({ [file]: 'import { describeRoles } from "../role-descriptions.js";' }),
      [],
    );
  assert.match(
    check({ "workflow/controller.ts": 'import { BridgeClient } from "../bridge.js";' }).join("\n"),
    /must not depend on the bridge process/,
  );
});
