import assert from "node:assert/strict";
import test from "node:test";
import { checkArchitecture, moduleImports } from "./architecture.mjs";
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
    /receive Pi execution/,
  );
  assert.match(
    check({
      "bridge/client.ts": 'import { decide } from "../workflow/knowledge/machine.js";',
    }).join("\n"),
    /must not depend on Pi workflow/,
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
    /receive Pi execution/,
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
