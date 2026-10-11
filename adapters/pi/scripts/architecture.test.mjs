import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { checkArchitecture, checkDependencies, moduleImports } from "./architecture.mjs";

const check = (files) => checkArchitecture(new Map(Object.entries(files)));

test("inspection uses pure shared metadata and bridge types without starting services", () => {
  assert.deepEqual(
    check({
      "inspection/roles.ts": 'export { describeRoles } from "@xper/adapter-shared";',
      "inspection/protocol.ts":
        'import type { AvailableModel } from "@xper/adapter-shared/bridge";',
      "inspection/cli.ts": 'import { listAvailableModels } from "../execution/models.js";',
    }),
    [],
  );
  for (const dependency of [
    "@xper/adapter-shared/workflow",
    "@xper/adapter-shared/bridge",
    "@xper/adapter-shared/configuration",
    "@xper/adapter-shared/actions",
    "@xper/adapter-shared/execution",
    "../extension.js",
    "../execution/child.js",
  ]) {
    assert.match(
      check({ "inspection/cli.ts": `export * from "${dependency}";` }).join("\n"),
      /must not start workflow or recording/,
    );
  }
});

test("only the declared shared entrypoints are public dependencies", () => {
  for (const suffix of ["", "/workflow", "/actions", "/execution", "/bridge", "/configuration"])
    assert.deepEqual(
      check({ "extension.ts": `export * from "@xper/adapter-shared${suffix}";` }),
      [],
    );
  for (const dependency of [
    "@xper/adapter-shared/workflow/controller",
    "@xper/adapter-shared/dist/workflow.js",
    "@xper/adapter-shared/src/workflow/controller.js",
    "@xper/adapter-other",
    "@xper/core",
    "xper-application",
  ])
    assert.match(
      check({ "extension.ts": `import type { Value } from "${dependency}";` }).join("\n"),
      /private xper module/,
    );
  assert.match(
    check({ "extension.ts": 'export * from "../../shared/src/workflow/controller.js";' }).join(
      "\n",
    ),
    /public package entrypoints/,
  );
  assert.deepEqual(checkDependencies(["@xper/adapter-shared", "@earendil-works/pi-tui"]), []);
  assert.match(checkDependencies(["@xper/core"]).join("\n"), /private xper package/);
});

test("Pi executors cannot drive shared workflow decisions or access recording", () => {
  for (const dependency of ["workflow", "actions", "bridge", "configuration"])
    assert.match(
      check({
        "execution/child.ts": `import { value } from "@xper/adapter-shared/${dependency}";`,
      }).join("\n"),
      /not drive workflow decisions/,
    );
  assert.deepEqual(
    check({
      "execution/roles.ts": 'import { capabilitiesForRole } from "@xper/adapter-shared";',
      "execution/child.ts": 'import type { ExecutionResult } from "@xper/adapter-shared/actions";',
    }),
    [],
  );
});

test("workflow commands and recording stay behind their local typed boundaries", () => {
  assert.match(
    check({ "pi/session.ts": 'client.request("configuration.resolve");' }).join("\n"),
    /typed xper client/,
  );
  assert.match(
    check({ "pi/xper-command.ts": 'client.request("run.start");' }).join("\n"),
    /workflow commands inside adapters/,
  );
  assert.match(
    check({ "pi/xper-tools.ts": "await client.waitForRecording();" }).join("\n"),
    /must not await telemetry/,
  );
});

test("dynamic and re-export dependencies cannot evade entrypoint restrictions", () => {
  assert.match(
    check({
      "inspection/cli.ts": 'const service = import("@xper/adapter-shared/workflow");',
    }).join("\n"),
    /must not start workflow or recording/,
  );
  for (const source of [
    'import { type BridgeClient } from "@xper/adapter-shared/bridge";',
    'export { type BridgeClient } from "@xper/adapter-shared/bridge";',
    'import bridge = require("@xper/adapter-shared/bridge");',
  ])
    assert.match(
      check({ "inspection/cli.ts": source }).join("\n"),
      /must not start workflow or recording/,
    );
  assert.equal(
    moduleImports("types.ts", 'export type { Value } from "./model.js";')[0].typeOnly,
    true,
  );
});

test("cycles include type-only imports and re-exports", () => {
  assert.match(
    check({
      "pi/a.ts": 'export * from "./b.js";',
      "pi/b.ts": 'import type { A } from "./a.js";',
    }).join("\n"),
    /Dependency cycle/,
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
  for (const entry of ["index"]) {
    const specifier = `@xper/adapter-pi${entry === "index" ? "" : `/${entry}`}`;
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
