import assert from "node:assert/strict";
import test from "node:test";
import { runKnowledge } from "../knowledge/delegate.js";
import { delegateKnowledge } from "../actions/delegate-knowledge.js";
import type { ModelUsage } from "../workflow/types.js";

const fakeExecutor = (messages: unknown[]) => `
  process.stdin.once('data', () => {
    for (const message of ${JSON.stringify(messages)}) {
      process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');
    }
    process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
    process.stdin.resume();
  });
`;

test("Pi captures per-message usage and observed models without prompts or response content", async () => {
  const result = await runKnowledge("private task", process.cwd(), undefined, {
    command: process.execPath,
    args: [
      "-e",
      fakeExecutor([
        {
          role: "assistant",
          provider: "test",
          model: "alias",
          responseModel: "actual",
          usage: {
            input: 10,
            output: 3,
            cacheRead: 5,
            cacheWrite: 0,
            cost: { total: 0.000012 },
          },
          content: [{ type: "text", text: "intermediate private content" }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        {
          role: "assistant",
          provider: "test",
          model: "actual",
          content: [{ type: "text", text: "final artifact" }],
        },
      ]),
    ],
    systemPrompt: "synthetic test",
    timeoutMs: 5000,
  });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.usage, [
    {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costMicros: 12,
      costSource: "pi_estimate",
      provider: "test",
      model: "actual",
    },
    {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costMicros: null,
      provider: "test",
      model: "actual",
    },
  ]);
  assert(!JSON.stringify(result.usage).includes("private"));
});

test("usage recording failure leaves the execution outcome and gate decision unchanged", async () => {
  const reports: ModelUsage[] = [];
  const events: string[] = [];
  const result = await delegateKnowledge(
    { task: "synthetic", cwd: "/unused", signal: new AbortController().signal },
    {
      workflow: {
        async startAssignment() {
          return {
            runId: "r",
            assignmentId: "a",
            attemptId: "t",
            role: "discovery.explorer",
            selection: null,
          };
        },
        async recordUsage(_attemptId, usage) {
          reports.push(usage);
          throw new Error("recorder unavailable");
        },
        async finishAttempt(completion) {
          assert.equal(completion.outcome, "succeeded");
          return { attemptId: "t", outcome: "succeeded", artifactId: "artifact" };
        },
        async advanceRun() {
          return { advanced: true, phase: "define" };
        },
      },
      async execute() {
        return {
          outcome: "succeeded",
          brief: "evidence",
          usage: [{ inputTokens: 4, costMicros: null }],
        };
      },
      async saveBrief() {
        return ".xper/artifacts/t.md";
      },
      observe(event) {
        events.push(event.type);
      },
    },
  );
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.phase, "define");
  assert.equal(reports.length, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(events.includes("recording.failed"));
});

test("hanging usage and throwing observers cannot hold the tool result or gate", {
  timeout: 5000,
}, async () => {
  let called = false;
  const result = await delegateKnowledge(
    { task: "synthetic", cwd: "/unused", signal: new AbortController().signal },
    {
      workflow: {
        async startAssignment() {
          return {
            runId: "r",
            assignmentId: "a",
            attemptId: "t",
            role: "discovery.explorer",
            selection: null,
          };
        },
        recordUsage() {
          called = true;
          return new Promise<void>(() => {});
        },
        async finishAttempt() {
          return { attemptId: "t", outcome: "succeeded", artifactId: "artifact" };
        },
        async advanceRun() {
          return { advanced: true, phase: "define" };
        },
      },
      async execute() {
        return { outcome: "succeeded", brief: "evidence", usage: [{ inputTokens: 3 }] };
      },
      async saveBrief() {
        return ".xper/artifacts/t.md";
      },
      observe() {
        throw new Error("observation sink unavailable");
      },
    },
  );
  assert(called);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.phase, "define");
});
