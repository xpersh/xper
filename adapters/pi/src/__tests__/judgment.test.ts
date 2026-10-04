import assert from "node:assert/strict";
import type { RoutingSnapshot } from "../bridge/xper-client.js";
import { readFileSync } from "node:fs";
import test from "node:test";
import { delegateWorkflow } from "../actions/delegate-workflow.js";
import { ProtocolFailure } from "../bridge/protocol.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import type { AdapterCheckpoint } from "../workflow/checkpoint/types.js";
import {
  parseJudgmentReport,
  verdicts,
  type JudgmentReport,
} from "../workflow/judgment/contract.js";
import { decodeJudgment } from "../workflow/judgment/checkpoint.js";
import { transitionJudgment } from "../workflow/judgment/machine.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { policyFrom } from "../workflow/policy.js";
import type { JudgmentAssignmentStarted } from "../workflow/types.js";
import { ready, reportFor, setVerdict } from "./judgment-harness.js";

function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined);
  return value;
}
const fixture = required(
  (
    JSON.parse(
      readFileSync(new URL("../../../../fixtures/judgment-v1.json", import.meta.url), "utf8"),
    ) as Array<{ artifact: JudgmentReport }>
  )[0],
).artifact;
const seed = {
  runId: "run",
  instanceId: "judge-instance",
  assignmentId: "judge-1",
  evaluation: fixture.evaluation,
  selection: null,
  model: "provider/frozen",
};
const start = () =>
  transitionJudgment(
    null,
    {
      type: "assignment.start",
      seed,
      attemptId: "attempt-1",
      policy: policyFrom({}),
      budget: { attempts: 2, timeMs: 1000, costMicros: null, concurrency: 1 },
    },
    100,
  );
const completedEvent = {
  type: "attempt.finish" as const,
  artifactId: "report-1",
  result: {
    attemptId: "attempt-1",
    outcome: "succeeded" as const,
    artifactPath: ".xper/artifacts/judgment-verdict-attempt-1.json",
  },
};

test("all seven Judge recommendations complete only their flow and settle idempotently", () => {
  for (const verdict of verdicts) {
    const started = start();
    const before = structuredClone(started.state);
    const report = structuredClone(fixture);
    setVerdict(report, verdict);
    const event = {
      ...completedEvent,
      evidence: { content: JSON.stringify(report), digest: "d".repeat(64) },
    };
    const completed = transitionJudgment(started.state, event, 101);
    assert.deepEqual(started.state, before);
    assert.equal(completed.state.report?.verdict, verdict);
    assert.deepEqual(decodeJudgment(completed.state), completed.state);
    assert(
      completed.facts.some(
        (fact) => fact.type === "workflow.transition" && fact.data.to === "reported",
      ),
    );
    assert(
      !completed.facts.some((fact) =>
        /gate\.|run.finished|rework|feedback|accepted/.test(fact.type),
      ),
    );
    assert.equal(completed.result.judgment?.applied, false);
    assert.deepEqual(transitionJudgment(completed.state, event, 10000).facts, []);
  }
});

test("Judge contracts reject missing criteria, unknown citations, unsupported verdicts and mismatched evidence", () => {
  const mutations: Array<(report: JudgmentReport) => void> = [
    (report) => {
      report.output.criteria = [];
    },
    (report) => {
      report.output.criteria.push(required(report.output.criteria[0]));
    },
    (report) => {
      required(report.output.criteria[0]).evidence = ["unregistered"];
    },
    (report) => {
      report.output.criticisms = [{ reason: "Concern", evidence: [] }];
    },
    (report) => {
      report.output.verdict = "accept" as "ACCEPT";
    },
    (report) => {
      report.output.assignmentId = "other";
    },
    (report) => {
      report.evaluation.evaluatedCommit = "3".repeat(40);
    },
    (report) => {
      required(report.output.criteria[0]).outcome = "unknown" as "passed";
    },
  ];
  for (const mutate of mutations) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(() =>
      parseJudgmentReport(JSON.stringify(report), fixture.evaluation, seed.assignmentId),
    );
  }
  assert.throws(() => parseJudgmentReport("not JSON", fixture.evaluation, seed.assignmentId));
});

test("interruption, cancellation and deadlines cannot complete Judgment or refund consumed attempts", () => {
  for (const outcome of ["failed", "cancelled", "timed_out"] as const) {
    const completed = transitionJudgment(
      start().state,
      { type: "attempt.finish", artifactId: "unused", result: { attemptId: "attempt-1", outcome } },
      101,
    );
    assert.equal(completed.state.report, null);
    assert.equal(completed.result.outcome, outcome);
  }
  const late = transitionJudgment(start().state, completedEvent, 1100);
  assert.equal(late.result.outcome, "timed_out");
  const recovered = transitionJudgment(start().state, { type: "session.recover" }, 101);
  assert.equal(recovered.state.attempts["attempt-1"]?.outcome, "interrupted");
  assert.deepEqual(transitionJudgment(recovered.state, { type: "session.recover" }, 102).facts, []);
  assert.equal(recovered.state.report, null);
});

test("two verified increments hand off through explicit delegation; reload preserves the unapplied report", async () => {
  const h = await ready();
  try {
    const result = await delegateWorkflow(
      {
        cwd: h.cwd,
        task: "Evaluate",
        model: "provider/judge",
        signal: new AbortController().signal,
      },
      {
        workflow: h.controller,
        execute: async (request) => {
          assert.equal(request.workflow, "judgment");
          if (request.workflow !== "judgment") assert.fail();
          assert.deepEqual(request.evaluation.incrementIds, ["s1", "s2"]);
          assert.equal(request.evaluation.baseCommit, "1".repeat(40));
          assert.equal(request.evaluation.evaluatedCommit, "3".repeat(40));
          assert.equal(request.evaluation.artifacts.length, 9);
          assert.equal(request.evaluation.logs.length, 4);
          const started = {
            ...request,
            runId: "unused",
            attemptId: "unused",
          } as JudgmentAssignmentStarted;
          return {
            outcome: "succeeded",
            brief: reportFor(started),
            usage: [{ provider: "actual-provider", model: "actual-model" }],
          };
        },
        saveBrief: async (_cwd, _attempt, content, path) => {
          assert(path);
          h.artifacts.set(path, { content, digest: "d".repeat(64) });
          return path;
        },
      },
    );
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.judgment?.verdict, "ACCEPT");
    assert.equal(result.gate, undefined);
    assert(result.artifactId);
    const restored = await h.restore();
    const status = await restored.getRunStatus();
    assert.equal(status.judgment?.artifactId, result.artifactId);
    assert.equal(status.judgment?.applied, false);
    await assert.rejects(
      restored.startAssignment(undefined, "different/model"),
      /already recorded/,
    );
    assert(
      h.recorder.events.some(
        (event) => event.type === "model.usage" && event.data.model === "actual-model",
      ),
    );
    assert(
      !h.recorder.events.some(
        (event) => event.type === "run.finished" || event.type === "increment.accepted",
      ),
    );
  } finally {
    await h.cleanup();
  }
});

test("Judge recovery freezes references and model, requires explicit retry, and rejects corrupt checkpoints", async () => {
  const h = await ready();
  try {
    const first = await h.controller.startAssignment(undefined, "provider/frozen");
    if (first.workflow !== "judgment") assert.fail();
    const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
    await journal.load();
    const checkpoint = journal.state as AdapterCheckpoint;
    await journal.close();
    assert.deepEqual(decodeAdapterCheckpoint(checkpoint), checkpoint);
    for (const mutate of [
      (state: AdapterCheckpoint) => {
        required(state.judgment).definition.version = 9;
      },
      (state: AdapterCheckpoint) => {
        required(required(state.judgment).evaluation.artifacts[0]).digest = "changed";
      },
      (state: AdapterCheckpoint) => {
        required(state.judgment).instanceId = state.knowledge.instanceId;
      },
      (state: AdapterCheckpoint) => {
        required(state.judgment).evaluation.evaluatedCommit = "4".repeat(40);
      },
    ]) {
      const corrupt = structuredClone(checkpoint);
      mutate(corrupt);
      assert.throws(() => decodeAdapterCheckpoint(corrupt));
    }
    const { judgment: _old, ...legacy } = checkpoint;
    assert.throws(
      () => decodeAdapterCheckpoint({ ...legacy, version: 6 }),
      /invalid Pi adapter checkpoint/,
    );
    for (const version of [4, 5])
      assert.equal(decodeAdapterCheckpoint({ ...legacy, version })?.judgment, null);
    const restored = await h.restore();
    await assert.rejects(
      restored.startAssignment(undefined, "provider/other"),
      /retry Judgment explicitly/,
    );
    const log = required(first.evaluation.logs[0]);
    h.artifacts.set(log.path, { content: "altered", digest: "altered" });
    await assert.rejects(
      restored.startAssignment(first.assignmentId, "provider/other"),
      /evidence changed/,
    );
    h.artifacts.set(log.path, { content: "Synthetic test passed", digest: log.digest });
    const retried = await restored.startAssignment(first.assignmentId, "provider/other");
    if (retried.workflow !== "judgment") assert.fail();
    assert.equal(retried.model, first.model);
    assert.deepEqual(retried.evaluation, first.evaluation);
    assert.equal(required(retried.budget).attempts, required(first.budget).attempts - 1);
    assert.notEqual(retried.attemptId, first.attemptId);
    await assert.rejects(
      restored.startAssignment(first.assignmentId, "provider/other"),
      /running attempt/,
    );
  } finally {
    await h.cleanup();
  }
});

test("malformed Judge output and missing evidence settle as failure through delegation", async (t) => {
  for (const mode of ["malformed", "missing"])
    await t.test(mode, async () => {
      const h = await ready();
      try {
        const result = await delegateWorkflow(
          {
            cwd: h.cwd,
            task: "Evaluate",
            model: "provider/judge",
            signal: new AbortController().signal,
          },
          {
            workflow: h.controller,
            execute: async (request) => {
              if (mode === "malformed") return { outcome: "succeeded", brief: "{}" };
              if (request.workflow !== "judgment") assert.fail();
              h.artifacts.delete(required(request.evaluation.artifacts[0]).path);
              return {
                outcome: "succeeded",
                brief: reportFor({
                  ...request,
                  runId: "unused",
                  attemptId: "unused",
                } as JudgmentAssignmentStarted),
              };
            },
            saveBrief: async (_cwd, _id, content, path) => {
              assert(path);
              h.artifacts.set(path, { content, digest: "invalid" });
              return path;
            },
          },
        );
        assert.equal(result.outcome, "failed");
        assert.equal((await h.controller.getRunStatus()).judgment?.status, "active");
        assert.equal(result.artifactId, null);
      } finally {
        await h.cleanup();
      }
    });
});

test("Judgment remains local with missing, rejecting or unanswered Rust", async (t) => {
  for (const mode of ["missing", "rejected", "unanswered"])
    await t.test(mode, { timeout: 5000 }, async () => {
      const h = await ready();
      const append = h.recorder.appendEvents;
      let release: (() => void) | undefined;
      try {
        await h.controller.waitForRecording();
        h.recorder.appendEvents = async () => {
          if (mode === "missing") throw new Error("offline");
          if (mode === "rejected") throw new ProtocolFailure(-32602, "rejected");
          return new Promise((resolve) => {
            release = () => resolve({ accepted: 0, durability: "persistent" });
          });
        };
        const started = await h.controller.startAssignment(undefined, "provider/judge");
        if (started.workflow !== "judgment") assert.fail();
        assert(started.artifactPath);
        h.artifacts.set(started.artifactPath, {
          content: reportFor(started),
          digest: "d".repeat(64),
        });
        const settled = await h.controller.finishAttempt({
          attemptId: started.attemptId,
          outcome: "succeeded",
          artifactPath: started.artifactPath,
        });
        assert.equal(settled.outcome, "succeeded");
        assert.equal((await h.controller.getRunStatus()).judgment?.applied, false);
      } finally {
        h.recorder.appendEvents = append;
        release?.();
        await h.cleanup();
      }
    });
});

test("Judge uses its configured route without requiring another provider or shopping for a replacement", async () => {
  const route = {
    context: "test",
    provider: "synthetic",
    model: "configured-judge",
    thinking: "off",
  };
  const roles = [
    "discovery.explorer",
    "define.product",
    "design.designer",
    "breakdown.slicer",
    "plan.planner",
    "implementation.driver",
    "verify.verifier",
  ];
  for (const configured of [false, true]) {
    const routing: RoutingSnapshot = {
      profile: "test",
      context: "test",
      routes: Object.fromEntries(
        [...roles, ...(configured ? ["judgment_day.judge"] : [])].map((role) => [role, [route]]),
      ),
    };
    const h = await ready(routing);
    try {
      if (!configured)
        await assert.rejects(
          h.controller.startAssignment(undefined, "other-provider/other-model"),
          /no judgment_day.judge route/,
        );
      else {
        const started = await h.controller.startAssignment(undefined, "other-provider/other-model");
        assert.deepEqual(started.selection, route);
        assert.equal(started.workflow, "judgment");
      }
    } finally {
      await h.cleanup();
    }
  }
});

test("Judgment admission enforces cumulative attempt, time and cost limits", () => {
  const budget = { attempts: 1, timeMs: 1000, costMicros: 10, concurrency: 1 };
  for (const exhausted of [{ attempts: 0 }, { timeMs: 0 }, { costMicros: 0 }])
    assert.throws(
      () =>
        transitionJudgment(
          null,
          {
            type: "assignment.start",
            seed,
            attemptId: "no-budget",
            budget: { ...budget, ...exhausted },
            policy: policyFrom({ attemptCostMicros: 10, maxCostMicros: 100 }),
          },
          100,
        ),
      /budget exhausted/,
    );
});
