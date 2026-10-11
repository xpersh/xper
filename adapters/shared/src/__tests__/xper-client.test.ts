import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolFailure, errorCode } from "../bridge/protocol.js";
import { XperClient, type RecordedEvent } from "../bridge/xper-client.js";

const event: RecordedEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  runId: "run-1",
  occurredAt: 100,
  type: "arbitrary.custom",
  data: { phase: "unfamiliar" },
};
function responding(result: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client = new XperClient({
    request: async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) });
      return result;
    },
  });
  return { client, calls };
}
function invalid(error: unknown): boolean {
  assert(error instanceof ProtocolFailure);
  assert.equal(error.code, errorCode.invalidRequest);
  assert.equal(error.data, undefined);
  return true;
}
test("typed recorder accepts extensible facts and opaque projections, with no workflow methods", async () => {
  const append = responding({ accepted: 1, durability: "persistent", futureField: true });
  assert.equal((await append.client.appendEvents([event])).accepted, 1);
  assert.deepEqual(append.calls, [{ method: "event.append", params: { events: [event] } }]);
  assert.equal(
    (await responding({ accepted: 0, durability: "persistent" }).client.appendEvents([event]))
      .accepted,
    0,
  );
  const status = {
    run: { runId: "run-1", phase: "future.custom" },
    timeline: [event],
    durability: "persistent",
    future: true,
  };
  assert.deepEqual(await responding(status).client.getRunStatus(), status);
  const client = append.client;
  assert.equal("startRun" in client, false);
  assert.equal("advanceRun" in client, false);
});
test("configuration client preserves model catalog and opaque adapter settings", async () => {
  const models = [{ provider: "corp", model: "m1", reasoning: true }];
  const config = { routing: null, adapterConfig: { futureFlow: { custom: true } } };
  const resolved = responding(config);
  assert.deepEqual(await resolved.client.resolveConfiguration(models), config);
  assert.deepEqual(resolved.calls, [{ method: "configuration.resolve", params: { models } }]);
  const routing = {
    profile: "work",
    context: "company",
    routes: {
      "custom.role": [{ context: "company", provider: "corp", model: "m1", thinking: "low" }],
    },
  };
  assert.deepEqual(await responding({ routing }).client.inspectProfile(), routing);
  assert.equal(await responding({ routing: null }).client.inspectProfile(), null);
});
test("typed client rejects malformed envelopes and never echoes response bodies", async () => {
  const status = { run: null, timeline: [], durability: "persistent" };
  const cases: Array<{ invoke(client: XperClient): Promise<unknown>; values: unknown[] }> = [
    {
      invoke: (c) => c.appendEvents([event]),
      values: [
        { accepted: -1, durability: "persistent" },
        { accepted: 2, durability: "persistent" },
        { accepted: 1, durability: "unknown" },
      ],
    },
    {
      invoke: (c) => c.getRunStatus(),
      values: [
        { ...status, run: undefined },
        { ...status, timeline: {} },
        { ...status, durability: "unknown" },
        { ...status, degradedReason: 1 },
        { ...status, nextCursor: 3 },
        { ...status, timeline: [{ ...event, occurredAt: -1 }] },
        { ...status, timeline: [{ ...event, data: [] }] },
      ],
    },
    {
      invoke: (c) => c.resolveConfiguration(),
      values: [
        { routing: null },
        { routing: {}, adapterConfig: {} },
        { routing: null, adapterConfig: [] },
      ],
    },
    {
      invoke: (c) => c.inspectProfile(),
      values: [
        { routing: undefined },
        { routing: { profile: "work", context: "company", routes: { role: [{}] } } },
      ],
    },
  ];
  for (const { invoke, values } of cases)
    for (const value of [null, [], {}, 42, ...values])
      await assert.rejects(invoke(responding(value).client), invalid);
  await assert.rejects(
    responding({ secret: "PRIVATE_RESPONSE" }).client.getRunStatus(),
    (error) => {
      assert(invalid(error));
      assert(error instanceof Error);
      assert.equal(error.message, "invalid run.status result");
      return true;
    },
  );
});
test("typed client aggregates bounded pages and pins the selected run", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const second = { ...event, eventId: "event-2" };
  const client = new XperClient({
    request: async (_method, params) => {
      calls.push(params);
      return {
        run: { runId: "run-1" },
        timeline: params?.after ? [second] : [event],
        durability: "persistent",
        nextCursor: params?.after ? null : "event-1",
      };
    },
  });
  assert.deepEqual((await client.getRunStatus()).timeline, [event, second]);
  assert.deepEqual(calls, [{}, { runId: "run-1", after: "event-1" }]);
  await assert.rejects(
    responding({
      run: { runId: "run-1" },
      timeline: [event],
      durability: "persistent",
      nextCursor: "event-1",
    }).client.getRunStatus(),
    invalid,
  );
});
test("typed client preserves transport and core validation errors", async () => {
  for (const error of [
    new Error("connection lost"),
    new ProtocolFailure(errorCode.invalidParams, "conflicting event"),
  ]) {
    const client = new XperClient({
      request: async () => {
        throw error;
      },
    });
    await assert.rejects(client.appendEvents([event]), (received) => received === error);
  }
});
