import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import { recoveryChanges } from "../workflow/checkpoint/recovery.js";
import { feedbackReplay, knowledgeFeedbackChange } from "../workflow/delivery/reconcile.js";
import { resumeChange } from "../workflow/delivery/resume.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { parseVerificationResult } from "../workflow/verification/result.js";
import {
  completeImplementation,
  completeVerification,
  sealPlan,
  setup,
} from "./workflow-harness.js";

const commit = "2222222222222222222222222222222222222222";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
async function checkpoint(h: Awaited<ReturnType<typeof setup>>) {
  await h.controller.waitForRecording();
  const journal = new WorkflowJournal(h.cwd, "session", h.recorder);
  await journal.load();
  const state = decodeAdapterCheckpoint(journal.state);
  assert(state);
  return state;
}
function identities() {
  let next = 0;
  return () => `identity-${++next}`;
}

test("recovery composes immutable per-flow changes and replay emits no facts", async (t) => {
  for (const role of ["implementation", "verification"] as const) {
    await t.test(role, async () => {
      const h = await setup({}, identities());
      try {
        await sealPlan(h);
        if (role === "verification") {
          await completeImplementation(h, commit);
          h.setWorkspace({ root: h.cwd, head: commit, clean: true, status: "" });
        }
        const assignment = await h.controller.startAssignment(undefined, "provider/model");
        const original = await checkpoint(h);
        const before = structuredClone(original);
        const changes = [...recoveryChanges(freeze(original), 2000)];
        assert.deepEqual(original, before);
        assert.deepEqual(
          changes.flatMap((change) => change.facts.map((fact) => fact.type)),
          ["attempt.finished", "workflow.position"],
        );
        const recovered = changes.at(-1)?.state;
        assert(recovered);
        const history =
          role === "implementation" ? recovered.implementations : recovered.verifications;
        assert.equal(history.s1?.at(-1)?.attempts[assignment.attemptId]?.outcome, "interrupted");
        assert.deepEqual(
          [...recoveryChanges(freeze(recovered), 3000)].flatMap((change) => change.facts),
          [],
        );
      } finally {
        await h.cleanup();
      }
    });
  }
});

test("feedback and resumption leave their source checkpoints and delivery histories unchanged", async () => {
  const h = await setup({ maxAttempts: 20 }, identities());
  try {
    await sealPlan(h);
    await completeImplementation(h, commit);
    h.setWorkspace({ root: h.cwd, head: commit, clean: true, status: "" });
    const beforeFeedback = await checkpoint(h);
    const rejected = await completeVerification(
      h,
      "rejected",
      "provider/model",
      h.controller,
      "ambiguous_criteria",
    );
    const afterFeedback = await checkpoint(h);
    // Reconstruct the durable boundary after Verification and before its Knowledge handoff.
    const pending = freeze({
      ...afterFeedback,
      knowledge: beforeFeedback.knowledge,
      authorizedPlan: beforeFeedback.authorizedPlan,
      reconciliations: [],
    });
    const original = structuredClone(pending);
    const verification = pending.verifications.s1?.at(-1);
    assert(verification && rejected.assignment.artifactPath);
    const content = h.artifacts.get(rejected.assignment.artifactPath)?.content;
    assert(content);
    const report = freeze(parseVerificationResult(content, verification));
    const change = knowledgeFeedbackChange(pending, verification, report, "revisit-fixed", 2000);
    assert.deepEqual(pending, original);
    assert.deepEqual(change.state.verifications, pending.verifications);
    assert.deepEqual(change.result, { advanced: true, phase: "define" });
    assert.deepEqual(
      change.facts.map((fact) => fact.type),
      [
        "artifact.invalidated",
        "artifact.invalidated",
        "artifact.invalidated",
        "artifact.invalidated",
        "phase.exited",
        "phase.revisited",
        "phase.entered",
        "workflow.transition",
        "workflow.position",
      ],
    );
    assert.equal(change.state.knowledge.visits.at(-1)?.id, "revisit-fixed");
    assert.equal(change.state.knowledge.revision, pending.knowledge.revision + 1);
    assert.deepEqual(feedbackReplay(freeze(change.state), verification), {
      advanced: true,
      phase: "define",
      resumed: true,
    });
    assert.deepEqual(
      knowledgeFeedbackChange(change.state, verification, report, "unused-visit", 3000).facts,
      [],
    );

    for (const phase of ["define", "design", "breakdown", "plan"]) {
      const produced = await h.produce();
      assert.equal(produced.assignment.phase, phase);
      assert.equal((await h.controller.advanceRun()).advanced, true);
    }
    const awaiting = freeze(await checkpoint(h));
    const awaitingCopy = structuredClone(awaiting);
    assert.throws(
      () => resumeChange(awaiting, commit, { head: commit, clean: false }),
      /clean dedicated checkout/,
    );
    const resumed = resumeChange(awaiting, commit, { head: commit, clean: true });
    assert.deepEqual(awaiting, awaitingCopy);
    assert.deepEqual(resumed.state.implementations, awaiting.implementations);
    assert.deepEqual(resumed.state.verifications, awaiting.verifications);
    assert.deepEqual(
      resumed.facts.map((fact) => fact.type),
      ["delivery.resumed"],
    );
    assert.deepEqual(resumed.state.authorizedPlan, {
      artifactId: awaiting.knowledge.accepted.plan,
      digest: awaiting.knowledge.artifacts[awaiting.knowledge.accepted.plan ?? ""]?.digest,
      baseCommit: commit,
    });
    const replay = resumeChange(freeze(resumed.state), commit, { head: commit, clean: true });
    assert.deepEqual(replay.facts, []);
    assert.equal(replay.result.replayed, true);
  } finally {
    await h.cleanup();
  }
});
