import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolFailure, errorCode } from "../bridge/protocol.js";
import { XperClient } from "../bridge/xper-client.js";

function responding(result: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client = new XperClient({
    async request(method, params) {
      calls.push({ method, ...(params ? { params } : {}) });
      return result;
    },
  });
  return { client, calls };
}

const assignment = {
  runId: "run-1",
  assignmentId: "assignment-1",
  attemptId: "attempt-1",
  role: "discovery.explorer",
  selection: null,
};
const status = {
  run: {
    run_id: "run-1",
    visits: [{ phase: "discovery" }],
    attempts: { running: { outcome: null }, recovered: { outcome: "interrupted" } },
    artifacts: {},
  },
  timeline: [],
  durability: "persistent",
  degradedReason: null,
};

function invalid(error: unknown): boolean {
  assert(error instanceof ProtocolFailure);
  assert.equal(error.code, errorCode.invalidRequest);
  assert.equal(error.data, undefined);
  return true;
}

test("typed client preserves workflow requests and accepts additive response fields", async () => {
  const started = { runId: "run-1", phase: "discovery", resumed: false, futureField: true };
  const start = responding(started);
  assert.deepEqual(await start.client.startRun("Explore"), started);
  assert.deepEqual(start.calls, [{ method: "run.start", params: { objective: "Explore" } }]);
  const catalog = [{ provider: "corp", model: "m1", reasoning: true }];
  const catalogCall = responding(started);
  await catalogCall.client.startRun("Explore", catalog);
  assert.deepEqual(catalogCall.calls, [
    { method: "run.start", params: { objective: "Explore", models: catalog } },
  ]);
  const resume = responding({ ...started, phase: null, resumed: true });
  assert.equal((await resume.client.startRun("Explore")).resumed, true);

  const routing = {
    profile: "work",
    context: "company",
    routes: {
      "discovery.explorer": [
        {
          context: "company",
          provider: "corp",
          model: "m1",
          thinking: "low",
        },
      ],
    },
  };
  assert.deepEqual(await responding({ routing }).client.inspectProfile(), routing);
  assert.equal(await responding({ routing: null }).client.inspectProfile(), null);

  const delegate = responding(assignment);
  assert.deepEqual(await delegate.client.startAssignment(), assignment);
  assert.deepEqual(await delegate.client.startAssignment("assignment-1"), assignment);
  assert.deepEqual(delegate.calls, [
    { method: "assignment.start", params: {} },
    { method: "assignment.start", params: { assignmentId: "assignment-1" } },
  ]);
  const advanced = responding({ advanced: true, phase: "define", resumed: true });
  assert.equal((await advanced.client.advanceRun()).phase, "define");
  assert.deepEqual(advanced.calls, [{ method: "run.advance", params: {} }]);
  const blocked = responding({
    advanced: false,
    phase: "discovery",
    reason: "pending assignments",
  });
  assert.equal((await blocked.client.advanceRun()).advanced, false);
  const query = responding(status);
  assert.deepEqual(await query.client.getRunStatus(), status);
  assert.deepEqual(query.calls, [{ method: "run.status", params: {} }]);
  const empty = { run: null, timeline: [], durability: "volatile" };
  assert.deepEqual(await responding(empty).client.getRunStatus(), empty);
});

test("typed client validates fresh and replayed attempt results without changing their wire shape", async () => {
  const completion = {
    attemptId: "attempt-1",
    outcome: "succeeded",
    artifactPath: ".xper/artifacts/brief.md",
  } as const;
  const finished = { attemptId: "attempt-1", outcome: "succeeded", artifactId: "artifact-1" };
  const fresh = responding(finished);
  assert.deepEqual(await fresh.client.finishAttempt(completion), finished);
  assert.deepEqual(fresh.calls, [{ method: "attempt.finish", params: completion }]);
  const replayed = { attemptId: "attempt-1", outcome: "succeeded", replayed: true };
  assert.deepEqual(await responding(replayed).client.finishAttempt(completion), replayed);
  for (const outcome of ["failed", "cancelled", "timed_out"] as const) {
    const result = { attemptId: "attempt-1", outcome, artifactId: null };
    assert.deepEqual(
      await responding(result).client.finishAttempt({ attemptId: "attempt-1", outcome }),
      result,
    );
  }
});

test("typed client rejects malformed responses before consumers use IDs or projection fields", async () => {
  const cases: Array<{ invoke(client: XperClient): Promise<unknown>; invalidResults: unknown[] }> =
    [
      {
        invoke: (client) => client.startRun("Explore"),
        invalidResults: [
          { phase: "discovery", resumed: false },
          { runId: " ", phase: null, resumed: false },
          { runId: "run", phase: 3, resumed: true },
          { runId: "run", phase: "discovery", resumed: "false" },
        ],
      },
      {
        invoke: (client) => client.inspectProfile(),
        invalidResults: [
          { routing: undefined },
          {
            routing: {
              profile: "work",
              context: "company",
              routes: { "discovery.explorer": [{}] },
            },
          },
        ],
      },
      {
        invoke: (client) => client.startAssignment(),
        invalidResults: [
          { ...assignment, attemptId: 42 },
          { ...assignment, role: "" },
          { ...assignment, runId: null },
          { ...assignment, assignmentId: undefined },
          { ...assignment, selection: { provider: "corp" } },
        ],
      },
      {
        invoke: (client) =>
          client.finishAttempt({
            attemptId: "attempt-1",
            outcome: "succeeded",
            artifactPath: "brief.md",
          }),
        invalidResults: [
          { attemptId: "attempt-1", outcome: "succeeded", artifactId: null },
          { attemptId: "attempt-1", outcome: "succeeded", artifactId: "" },
          { attemptId: "attempt-1", outcome: "succeeded", replayed: "true" },
          { attemptId: "attempt-1", outcome: "interrupted", replayed: true },
        ],
      },
      {
        invoke: (client) => client.advanceRun(),
        invalidResults: [
          { advanced: "false", phase: "discovery" },
          { advanced: false, phase: "discovery" },
          { advanced: true, phase: null },
          { advanced: true, phase: "define", resumed: "true" },
        ],
      },
      {
        invoke: (client) => client.getRunStatus(),
        invalidResults: [
          { ...status, run: undefined },
          { ...status, timeline: {} },
          { ...status, durability: "unknown" },
          { ...status, degradedReason: 1 },
          { ...status, run: { ...status.run, visits: [null] } },
          { ...status, run: { ...status.run, visits: [{ phase: 4 }] } },
          { ...status, run: { ...status.run, attempts: [] } },
          { ...status, run: { ...status.run, attempts: { attempt: {} } } },
          { ...status, run: { ...status.run, attempts: { attempt: { outcome: "done" } } } },
          { ...status, run: { ...status.run, artifacts: null } },
        ],
      },
    ];
  for (const entry of cases) {
    for (const result of [null, [], {}, 42, ...entry.invalidResults]) {
      await assert.rejects(entry.invoke(responding(result).client), invalid);
    }
  }
});

test("typed client rejects mismatched correlations and outcomes", async () => {
  await assert.rejects(
    responding(assignment).client.startAssignment("another-assignment"),
    invalid,
  );
  for (const result of [
    { attemptId: "another-attempt", outcome: "failed", artifactId: null },
    { attemptId: "attempt-1", outcome: "cancelled", artifactId: null },
    { attemptId: "attempt-1", outcome: "failed", artifactId: "unexpected-artifact" },
  ]) {
    await assert.rejects(
      responding(result).client.finishAttempt({ attemptId: "attempt-1", outcome: "failed" }),
      invalid,
    );
  }
});

test("typed client preserves bridge errors and excludes response payloads from validation failures", async () => {
  for (const error of [
    new Error("connection lost"),
    new ProtocolFailure(errorCode.invalidParams, "unknown attempt"),
  ]) {
    const client = new XperClient({
      request: async () => {
        throw error;
      },
    });
    await assert.rejects(client.getRunStatus(), (received) => received === error);
  }
  const payload = { ...assignment, attemptId: { secret: "PRIVATE_RESPONSE" } };
  await assert.rejects(responding(payload).client.startAssignment(), (error) => {
    assert(invalid(error));
    assert(error instanceof Error);
    assert.equal(error.message, "invalid assignment.start result");
    assert.doesNotMatch(error.message, /PRIVATE_RESPONSE/);
    return true;
  });
});
