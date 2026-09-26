import assert from "node:assert/strict";
import test from "node:test";

import { adapterPackage } from "../index.js";

test("declares a public-protocol adapter boundary", () => {
  assert.deepEqual(adapterPackage, {
    harness: "pi",
    packageName: "@xper/adapter-pi",
    protocolBoundary: "public",
  });
});
