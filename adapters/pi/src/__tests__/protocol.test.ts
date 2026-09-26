import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ProtocolFailure,
  decodeFrame,
  decodeMessage,
  encodeFrame,
  errorCode,
} from "../bridge/protocol.js";

interface Fixture {
  name: string;
  message: unknown;
  errorCode?: number;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../fixtures/protocol-v1.json", import.meta.url), "utf8"),
) as Fixture[];

for (const fixture of fixtures) {
  test(`shared contract: ${fixture.name}`, () => {
    if (fixture.errorCode !== undefined) {
      assert.throws(
        () => decodeMessage(fixture.message),
        (error: unknown) => error instanceof ProtocolFailure && error.code === fixture.errorCode,
      );
      return;
    }
    const message = decodeMessage(fixture.message);
    assert.deepEqual(message, fixture.message);
    assert.deepEqual(decodeFrame(encodeFrame(message)), message);
  });
}

test("frame parse and size errors are stable", () => {
  assert.throws(
    () => decodeFrame(Buffer.from("{")),
    (error: unknown) => error instanceof ProtocolFailure && error.code === errorCode.parseError,
  );
  assert.throws(
    () => decodeFrame(Buffer.alloc(65_537, 120)),
    (error: unknown) => error instanceof ProtocolFailure && error.code === errorCode.frameTooLarge,
  );
});
