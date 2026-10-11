import assert from "node:assert/strict";
import test from "node:test";
import { XperWorkflow } from "../workflow/controller.js";
import { decodeAdapterCheckpoint } from "../workflow/checkpoint/decode.js";
import type { AdapterCheckpoint } from "../workflow/checkpoint/types.js";
import { definitionFamily, type DefinitionFamily } from "../workflow/definition-identity.js";
import {
  definitionForKnowledge,
  knowledgeDefinition,
  legacyKnowledgeDefinition,
} from "../workflow/knowledge/definition.js";
import {
  definitionForImplementation,
  implementationDefinition,
  implementationReworkDefinition,
  legacyImplementationDefinition,
  legacyImplementationReworkDefinition,
} from "../workflow/implementation/definition.js";
import {
  definitionForVerification,
  verificationDefinition,
  legacyVerificationDefinition,
} from "../workflow/verification/definition.js";
import {
  definitionForJudgment,
  judgmentDefinition,
  legacyJudgmentDefinition,
} from "../workflow/judgment/definition.js";
import { WorkflowJournal } from "../workflow/journal.js";
import { decodeCheckpoint } from "../workflow/knowledge/checkpoint.js";
import type { JudgmentReport } from "../workflow/judgment/contract.js";
import { judgmentPosition } from "../workflow/judgment/state.js";
import {
  completeImplementation,
  completeVerification,
  fixtures,
  sealPlan,
  setup,
} from "./workflow-harness.js";
import { reportFor } from "./judgment-harness.js";

const pairs = [
  [knowledgeDefinition, legacyKnowledgeDefinition, definitionForKnowledge],
  [implementationDefinition, legacyImplementationDefinition, definitionForImplementation],
  [
    implementationReworkDefinition,
    legacyImplementationReworkDefinition,
    definitionForImplementation,
  ],
  [verificationDefinition, legacyVerificationDefinition, definitionForVerification],
  [judgmentDefinition, legacyJudgmentDefinition, definitionForJudgment],
] as const;

test("built-in workflow families preserve versions and topology and reject unknown identities", () => {
  for (const [current, legacy, resolve] of pairs) {
    assert.equal(definitionFamily(current.id), "xper");
    assert.equal(definitionFamily(legacy.id), "pi");
    assert.deepEqual({ ...legacy, id: current.id }, current);
    assert.equal(resolve(current), current);
    assert.equal(resolve(legacy), legacy);
    for (const invalid of [
      { ...current, id: "other.knowledge" },
      { ...current, version: 99 },
      { ...legacy, version: 0 },
    ])
      assert.throws(() => resolve(invalid), /unsupported .* definition/);
  }
  assert.throws(() => definitionForKnowledge({ id: "xper.knowledge", version: 1 }), /unsupported/);
  assert.throws(() => definitionFamily("xper.unknown"), /unsupported/);
});

async function familyRun(family: DefinitionFamily) {
  const h = await setup({ maxAttempts: 60 });
  const plan = structuredClone(
    fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output,
  );
  assert(plan?.kind === "execution_plan");
  for (const assignment of plan.assignments) assignment.maxAttempts = 6;
  await sealPlan(h, plan);
  await h.controller.waitForRecording();
  const source = new WorkflowJournal(h.cwd, "session", h.recorder, "pi");
  await source.load();
  const seed = decodeAdapterCheckpoint(source.state);
  assert(seed);
  assert.equal(seed.knowledge.definition.id, "xper.knowledge");
  seed.knowledge.definition.id = `${family}.knowledge`;
  const sessionId = `${family}-family`;
  const target = new WorkflowJournal(h.cwd, sessionId, h.recorder, "pi");
  await target.commit(seed, []);
  await target.close();
  const controller = new XperWorkflow(h.recorder, h.cwd, sessionId, {
    ...h.options,
    adapterId: "pi",
  });
  assert.equal((await controller.getRunStatus()).workflow?.definitionId, `${family}.knowledge`);
  return {
    ...h,
    plan,
    active: controller,
    firstEvent: h.recorder.events.length,
    checkpoint: async () => {
      const journal = new WorkflowJournal(h.cwd, sessionId, h.recorder, "pi");
      await journal.load();
      const checkpoint = decodeAdapterCheckpoint(journal.state);
      assert(checkpoint);
      return checkpoint;
    },
    cleanup: async () => {
      await controller.waitForRecording();
      await controller.stopRecording();
      await h.cleanup();
    },
  };
}

function flowStates(checkpoint: AdapterCheckpoint) {
  return [
    checkpoint.knowledge,
    ...Object.values(checkpoint.implementations).flat(),
    ...Object.values(checkpoint.verifications).flat(),
    ...checkpoint.judgmentHistory.map((entry) => entry.state),
    ...(checkpoint.judgment ? [checkpoint.judgment] : []),
  ];
}

async function evaluate(
  h: Awaited<ReturnType<typeof familyRun>>,
  verdict: "ACCEPT" | "REWORK_IMPLEMENTATION",
) {
  const started = await h.active.startAssignment(undefined, "provider/judge");
  assert(started.workflow === "judgment" && started.artifactPath);
  const report = JSON.parse(reportFor(started)) as JudgmentReport;
  report.output.verdict = verdict;
  const content = JSON.stringify(report);
  h.artifacts.set(started.artifactPath, { content, digest: content });
  const finished = await h.active.finishAttempt({
    attemptId: started.attemptId,
    outcome: "succeeded",
    artifactPath: started.artifactPath,
  });
  assert(!finished.replayed && finished.artifactId);
  return {
    started,
    artifactPath: started.artifactPath,
    reportId: finished.artifactId,
    revision: started.evaluation.evaluatedCommit,
  };
}

for (const family of ["pi", "xper"] as const) {
  test(`${family} recovery keeps the family through delivery, Judge rework, recording and closure`, async () => {
    const h = await familyRun(family);
    try {
      const initial = await h.checkpoint();
      assert.deepEqual(decodeCheckpoint(initial.knowledge), initial.knowledge);
      for (const digit of ["2", "3"]) {
        await completeImplementation(h, digit.repeat(40), "provider/model", h.active);
        h.setWorkspace({ root: h.cwd, head: digit.repeat(40), clean: true, status: "" });
        await completeVerification(h, "verified", "provider/model", h.active);
        const judged = await evaluate(h, digit === "2" ? "REWORK_IMPLEMENTATION" : "ACCEPT");
        const position = (await h.active.getRunStatus()).judgment;
        assert.equal(position?.definitionId, `${family}.judgment`);
        await h.active.applyJudgment(judged.reportId, judged.revision);
        const replay = await h.active.finishAttempt({
          attemptId: judged.started.attemptId,
          outcome: "succeeded",
          artifactPath: judged.artifactPath,
        });
        assert.equal(replay.replayed, true);
        await h.active.recordUsage(judged.started.attemptId, { inputTokens: 2 });
      }
      const checkpoint = await h.checkpoint();
      assert.equal(checkpoint.version, 9);
      assert.equal(checkpoint.closure?.status, "accepted");
      assert.equal(checkpoint.judgmentHistory.length, 1);
      assert.deepEqual(
        checkpoint.implementations.s1?.map((state) => state.definition.version),
        [1, 2],
      );
      assert(
        flowStates(checkpoint).every((state) => definitionFamily(state.definition.id) === family),
      );
      assert(checkpoint.judgment);
      assert.equal(judgmentPosition(checkpoint.judgment).definitionId, `${family}.judgment`);
      for (let index = 0; index < flowStates(checkpoint).length; index++) {
        const mixed = structuredClone(checkpoint);
        const state = flowStates(mixed)[index];
        assert(state);
        state.definition.id = state.definition.id.replace(
          `${family}.`,
          family === "pi" ? "xper." : "pi.",
        );
        assert.throws(() => decodeAdapterCheckpoint(mixed), /mixed workflow definition families/);
      }
      await h.active.waitForRecording();
      const events = h.recorder.events.slice(h.firstEvent);
      assert(events.length > 0);
      for (const event of events) {
        assert.equal(definitionFamily(String(event.data.definitionId)), family);
        if (event.type === "adapter.state" || event.type === "adapter.state.chunk")
          assert.equal(event.data.adapter, "pi");
      }
      assert(
        events.some(
          (event) =>
            event.type === "workflow.definition" &&
            event.data.definitionId === `${family}.implementation` &&
            event.data.definitionVersion === 2,
        ),
      );
      const usage = events.filter((event) => event.type === "model.usage");
      assert.equal(usage.length, 2);
      assert(usage.every((event) => event.data.definitionId === `${family}.judgment`));
    } finally {
      await h.cleanup();
    }
  });

  test(`${family} recovery retains its family across Knowledge feedback and revised Plan resumption`, async () => {
    const h = await familyRun(family);
    try {
      await completeImplementation(h, "2".repeat(40), "provider/model", h.active);
      h.setWorkspace({ root: h.cwd, head: "2".repeat(40), clean: true, status: "" });
      await completeVerification(h, "rejected", "provider/model", h.active, "ambiguous_criteria");
      assert.equal((await h.active.getRunStatus()).workflow?.definitionId, `${family}.knowledge`);
      for (const phase of ["define", "design", "breakdown", "plan"]) {
        const assignment = await h.active.startAssignment();
        assert.equal(assignment.phase, phase);
        assert(assignment.artifactPath);
        const content = JSON.stringify({
          schemaVersion: 1,
          inputs: assignment.inputArtifacts?.map((artifact) => artifact.artifact_id),
          output:
            phase === "plan"
              ? h.plan
              : fixtures.find((fixture) => fixture.phase === phase)?.artifact.output,
        });
        h.artifacts.set(assignment.artifactPath, { content, digest: content });
        await h.active.finishAttempt({
          attemptId: assignment.attemptId,
          outcome: "succeeded",
          artifactPath: assignment.artifactPath,
        });
        assert((await h.active.advanceRun()).advanced);
      }
      await h.active.resumeDelivery("2".repeat(40));
      await completeImplementation(h, "3".repeat(40), "provider/model", h.active);
      const checkpoint = await h.checkpoint();
      assert(
        flowStates(checkpoint).every((state) => definitionFamily(state.definition.id) === family),
      );
      assert.equal(checkpoint.reconciliations.at(-1)?.status, "resumed");
      await h.active.waitForRecording();
      for (const event of h.recorder.events.slice(h.firstEvent))
        assert.equal(definitionFamily(String(event.data.definitionId)), family);
    } finally {
      await h.cleanup();
    }
  });
}
