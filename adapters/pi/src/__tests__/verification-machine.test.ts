import assert from "node:assert/strict";
import test from "node:test";
import { findTransition, verificationDefinition } from "../workflow/definition.js";
import {
  decodeVerificationState,
  transitionVerification,
  type VerificationEvent,
} from "../workflow/verification.js";

const base = "1111111111111111111111111111111111111111";
const evaluated = "2222222222222222222222222222222222222222";
const artifactPath = ".xper/artifacts/verification-result-v1.json";

function startEvent(
  attemptId = "v1",
  assignmentId?: string,
): Extract<VerificationEvent, { type: "assignment.start" }> {
  return {
    type: "assignment.start",
    runId: "run",
    instanceId: "verification-s1-1",
    attemptId,
    ...(assignmentId ? { assignmentId } : {}),
    planArtifactId: "plan",
    planDigest: "sealed-plan",
    implementation: {
      instanceId: "implementation-s1-1",
      artifactId: "implementation-result",
      digest: "implementation-digest",
      baseCommit: base,
      evaluatedCommit: evaluated,
      testCommands: ["npm test"],
    },
    assignment: {
      id: "verifier",
      incrementId: "s1",
      role: "verify.verifier",
      dependencies: ["driver"],
      workspace: "s1",
      resources: [],
      maxAttempts: 3,
      maxTimeMs: 1_000,
      maxCostMicros: 0,
    },
    inputs: ["brief", "definition", "design", "breakdown", "plan", "implementation-result"],
    inputArtifacts: [
      {
        artifact_id: "implementation-result",
        kind: "implementation_result",
        path: ".xper/artifacts/implementation-result-i1.json",
        version: 1,
      },
    ],
    criteria: [{ id: "c1", behavior: "Works", example: "Observed" }],
    verification: ["run the focused test"],
    selection: null,
    model: "synthetic/model",
    attemptTimeMs: 500,
    attemptCostMicros: 0,
    assignmentBudget: { attempts: 3, timeMs: 1_000, costMicros: 0, concurrency: 1 },
    globalBudget: { attempts: 10, timeMs: 10_000, costMicros: null, concurrency: 1 },
  };
}

function report(verdict: "verified" | "rejected" = "verified") {
  const failed = verdict === "rejected";
  return {
    content: JSON.stringify({
      schemaVersion: 1,
      inputs: ["brief", "definition", "design", "breakdown", "plan", "implementation-result"],
      output: {
        kind: "verification_result",
        assignmentId: "verifier",
        incrementId: "s1",
        implementationArtifactId: "implementation-result",
        baseCommit: base,
        evaluatedCommit: evaluated,
        verdict,
        tests: [
          {
            command: "npm test",
            exitCode: 0,
            outputPath: ".xper/artifacts/test-output-v1-1.log",
          },
        ],
        criteria: [
          {
            criterionId: "c1",
            outcome: failed ? "failed" : "passed",
            evidence: failed ? "The behavior is wrong" : "The focused test passes",
            paths: ["src/change.ts"],
          },
        ],
        review: {
          regressions: { outcome: "passed", evidence: "Suite passes", paths: [] },
          scope: { outcome: "passed", evidence: "Diff is focused", paths: ["src/change.ts"] },
          simplicity: {
            outcome: "passed",
            evidence: "No unnecessary layers",
            paths: ["src/change.ts"],
          },
        },
        rejection: failed
          ? { cause: "criterion failed", evidence: "Observed mismatch", paths: ["src/change.ts"] }
          : null,
      },
    }),
    digest: `verification-${verdict}`,
  };
}

test("verification has an independent definition and acceptance completes only its instance", () => {
  assert.equal(verificationDefinition.id, "pi.verification");
  assert.deepEqual(
    verificationDefinition.nodes.map((node) => node.id),
    ["verify", "verified", "rejected"],
  );
  const started = transitionVerification(null, startEvent(), 100);
  assert.equal(started.result.workflow, "verification");
  assert.equal(started.result.evaluatedCommit, evaluated);
  const finished = transitionVerification(
    started.state,
    {
      type: "attempt.finish",
      result: { attemptId: "v1", outcome: "succeeded", artifactPath },
      artifactId: "verification-result",
      evidence: report(),
    },
    200,
  );
  assert.deepEqual(finished.state.lifecycle, {
    status: "completed",
    artifactId: "verification-result",
    verdict: "verified",
  });
  const transition = finished.facts.find((fact) => fact.type === "workflow.transition");
  assert(transition);
  assert.equal(
    findTransition(verificationDefinition, "verify", String(transition.data.transitionId))?.to,
    "verified",
  );
  assert(!finished.facts.some((fact) => fact.type === "run.finished"));
  const replay = transitionVerification(
    finished.state,
    {
      type: "attempt.finish",
      result: { attemptId: "v1", outcome: "succeeded", artifactPath },
      artifactId: "ignored-on-replay",
      evidence: report(),
    },
    210,
  );
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.facts.length, 0);
});

test("a valid rejection completes review and records explicit rework evidence", () => {
  const started = transitionVerification(null, startEvent(), 100);
  const finished = transitionVerification(
    started.state,
    {
      type: "attempt.finish",
      result: { attemptId: "v1", outcome: "succeeded", artifactPath },
      artifactId: "rejection",
      evidence: report("rejected"),
    },
    200,
  );
  assert.deepEqual(finished.state.lifecycle, {
    status: "completed",
    artifactId: "rejection",
    verdict: "rejected",
  });
  assert(finished.facts.some((fact) => fact.type === "implementation.rework_requested"));
  assert(finished.facts.some((fact) => fact.type === "artifact.invalidated"));
  assert.deepEqual(decodeVerificationState(finished.state), finished.state);
});

test("malformed or inconsistent verification evidence cannot complete a gate", () => {
  const started = transitionVerification(null, startEvent(), 100);
  const inconsistent = report();
  const document = JSON.parse(inconsistent.content) as { output: { verdict: string } };
  document.output.verdict = "rejected";
  inconsistent.content = JSON.stringify(document);
  assert.throws(
    () =>
      transitionVerification(
        started.state,
        {
          type: "attempt.finish",
          result: { attemptId: "v1", outcome: "succeeded", artifactPath },
          artifactId: "invalid",
          evidence: inconsistent,
        },
        200,
      ),
    /inconsistent/,
  );
});

test("recovery interrupts once and retries preserve identity and cumulative limits", () => {
  const started = transitionVerification(null, startEvent(), 100);
  assert.throws(
    () => transitionVerification(started.state, startEvent("overlap"), 110),
    /already running/,
  );
  const recovered = transitionVerification(started.state, { type: "session.recover" }, 150);
  assert.equal(recovered.state.attempts.v1?.outcome, "interrupted");
  assert.equal(
    transitionVerification(recovered.state, { type: "session.recover" }, 160).facts.length,
    0,
  );
  assert.throws(
    () => transitionVerification(recovered.state, startEvent("v2"), 170),
    /retry interrupted assignment verifier explicitly/,
  );
  const retry = startEvent("v2", "verifier");
  retry.assignmentBudget.attempts = 0;
  assert.throws(
    () => transitionVerification(recovered.state, retry, 170),
    /assignment attempt budget exhausted/,
  );
});
