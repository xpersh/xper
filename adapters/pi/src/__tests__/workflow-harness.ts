import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RecordedEvent,
  RecordedStatus,
  RecorderClient,
  RoutingSnapshot,
} from "../bridge/xper-client.js";
import { PiWorkflow } from "../workflow/controller.js";
import { saveArtifact } from "../execution/artifacts.js";
import { readEvidence } from "../workflow/evidence.js";
import type { Document, Output } from "../workflow/knowledge/contract.js";
import type { WorkflowPolicy } from "../workflow/types.js";

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../fixtures/knowledge-v1.json", import.meta.url)),
    "utf8",
  ),
) as Array<{ phase: string; artifact: Document }>;
class Recorder implements RecorderClient {
  events: RecordedEvent[] = [];
  offline = false;
  volatile = false;
  routing: RoutingSnapshot | null = null;
  config: WorkflowPolicy = {};
  async appendEvents(events: RecordedEvent[]) {
    if (this.offline) throw new Error("offline");
    let accepted = 0;
    for (const event of events) {
      const existing = this.events.find((e) => e.eventId === event.eventId);
      if (existing) {
        assert.deepEqual(existing, event);
        continue;
      }
      this.events.push(structuredClone(event));
      accepted++;
    }
    return {
      accepted,
      durability: this.volatile ? ("volatile" as const) : ("persistent" as const),
    };
  }
  async getRunStatus(): Promise<RecordedStatus> {
    if (this.offline) throw new Error("offline");
    return {
      run: this.events.length ? { runId: this.events[0]?.runId } : null,
      timeline: structuredClone(this.events),
      durability: "persistent",
    };
  }
  async inspectProfile() {
    return this.routing;
  }
  async resolveConfiguration() {
    return { routing: this.routing, adapterConfig: { ...this.config } };
  }
}
async function setup(
  policy: WorkflowPolicy = {},
  id?: () => string,
  routing: RoutingSnapshot | null = null,
) {
  const cwd = await mkdtemp(join(tmpdir(), "xper-pi-policy-"));
  const recorder = new Recorder();
  recorder.config = policy;
  recorder.routing = routing;
  const artifacts = new Map<string, { content: string; digest: string }>();
  let now = 1000;
  let workspace = {
    root: cwd,
    head: "1111111111111111111111111111111111111111",
    clean: true,
    status: "",
  };
  const options = {
    writeArtifact: async (id: string, content: string, path: string) => {
      await saveArtifact(cwd, id, content, path);
      artifacts.set(path, await readEvidence(cwd, path));
      return path;
    },
    ...(id ? { id } : {}),
    configuration: () => ({ routing: recorder.routing, adapterConfig: { ...recorder.config } }),
    now: () => now,
    readArtifact: async (path: string) => {
      const result = artifacts.get(path);
      if (!result) throw new Error("artifact unavailable");
      return result;
    },
    inspectWorkspace: async () => structuredClone(workspace),
  };
  const controller = new PiWorkflow(recorder, cwd, "session", options);
  const controllers = [controller];
  const produce = async (output?: Output) => {
    const assignment = await controller.startAssignment();
    assert(assignment.artifactPath);
    const content =
      assignment.phase === "discovery"
        ? "# Brief\nEvidence"
        : JSON.stringify({
            schemaVersion: 1,
            inputs: assignment.inputArtifacts?.map((a) => a.artifact_id),
            output: output ?? fixtures.find((f) => f.phase === assignment.phase)?.artifact.output,
          });
    artifacts.set(assignment.artifactPath, { content, digest: content });
    const result = await controller.finishAttempt({
      attemptId: assignment.attemptId,
      outcome: "succeeded",
      artifactPath: assignment.artifactPath,
    });
    return { assignment, result };
  };
  await controller.startRun("Synthetic objective");
  return {
    cwd,
    recorder,
    controller,
    artifacts,
    options,
    produce,
    advanceTime: (ms: number) => {
      now += ms;
    },
    setWorkspace: (next: typeof workspace) => {
      workspace = structuredClone(next);
    },
    restore: async () => {
      for (const previous of controllers) {
        await previous.waitForRecording();
        previous.stopRecording();
      }
      const restored = new PiWorkflow(recorder, cwd, "session", options);
      controllers.push(restored);
      return restored;
    },
    cleanup: async () => {
      for (const workflow of controllers) {
        await workflow.waitForRecording();
        workflow.stopRecording();
      }
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function sealPlan(harness: Awaited<ReturnType<typeof setup>>, plan?: Output) {
  let planPath = "";
  for (const phase of ["discovery", "define", "design", "breakdown", "plan"]) {
    const produced = await harness.produce(phase === "plan" ? plan : undefined);
    planPath = produced.assignment.artifactPath ?? planPath;
    const gate = await harness.controller.advanceRun();
    assert(gate.advanced);
  }
  return planPath;
}

function twoIncrementOutputs(dependent: boolean) {
  const definition = structuredClone(
    fixtures.find((fixture) => fixture.phase === "define")?.artifact.output,
  );
  const breakdown = structuredClone(
    fixtures.find((fixture) => fixture.phase === "breakdown")?.artifact.output,
  );
  const plan = structuredClone(
    fixtures.find((fixture) => fixture.phase === "plan")?.artifact.output,
  );
  assert(definition?.kind === "definition_contract");
  assert(breakdown?.kind === "story_map");
  assert(plan?.kind === "execution_plan");
  definition.criteria.push({ id: "c2", behavior: "Returns a farewell", example: "Goodbye Ada" });
  breakdown.stories.push({
    id: "s2",
    value: "Receive a farewell",
    criteria: ["c2"],
    verification: ["assert farewell for a synthetic name"],
    independentlyVerifiable: true,
    dependencies: dependent ? ["s1"] : [],
  });
  const [driver, verifier] = plan.assignments;
  assert(driver && verifier);
  plan.assignments.push(
    {
      ...driver,
      id: "driver-2",
      incrementId: "s2",
      dependencies: dependent ? [verifier.id] : [],
      workspace: "s2",
    },
    {
      ...verifier,
      id: "verifier-2",
      incrementId: "s2",
      dependencies: ["driver-2"],
      workspace: "s2",
    },
  );
  return { definition, breakdown, plan };
}

async function sealTwoIncrementPlan(
  harness: Awaited<ReturnType<typeof setup>>,
  dependent = true,
  maxAttempts = 1,
) {
  const outputs = twoIncrementOutputs(dependent);
  for (const assignment of outputs.plan.assignments) assignment.maxAttempts = maxAttempts;
  for (const phase of ["discovery", "define", "design", "breakdown", "plan"]) {
    const output =
      phase === "define"
        ? outputs.definition
        : phase === "breakdown"
          ? outputs.breakdown
          : phase === "plan"
            ? outputs.plan
            : undefined;
    await harness.produce(output);
    const gate = await harness.controller.advanceRun();
    assert(gate.advanced);
  }
  return outputs;
}

async function completeImplementation(
  harness: Awaited<ReturnType<typeof setup>>,
  resultingCommit: string,
  fallbackModel = "provider/model",
  controller = harness.controller,
) {
  const assignment = await controller.startAssignment(undefined, fallbackModel);
  assert.equal(assignment.workflow, "implementation");
  if (assignment.workflow !== "implementation") assert.fail("implementation assignment expected");
  assert(assignment.artifactPath);
  const content = JSON.stringify({
    schemaVersion: 1,
    inputs: assignment.inputArtifacts?.map((artifact) => artifact.artifact_id),
    output: {
      kind: "implementation_result",
      assignmentId: assignment.assignmentId,
      incrementId: assignment.incrementId,
      baseCommit: assignment.baseCommit,
      resultingCommit,
      changedFiles: ["src/change.ts"],
      tests: [
        {
          command: "npm test",
          exitCode: 0,
          outputPath: `.xper/artifacts/test-output-${assignment.attemptId}-1.log`,
        },
      ],
      criteria: assignment.criteria.map((criterion) => ({
        criterionId: criterion.id,
        evidence: "host-observed test",
        paths: ["src/change.ts"],
      })),
    },
  });
  harness.artifacts.set(assignment.artifactPath, { content, digest: content });
  harness.artifacts.set(`.xper/artifacts/test-output-${assignment.attemptId}-1.log`, {
    content: "Synthetic test passed",
    digest: "synthetic-test-log",
  });
  const finished = await controller.finishAttempt({
    attemptId: assignment.attemptId,
    outcome: "succeeded",
    artifactPath: assignment.artifactPath,
  });
  assert.equal(finished.replayed, undefined);
  if (finished.replayed) assert.fail("new implementation result expected");
  assert(finished.artifactId);
  return { assignment, artifactId: finished.artifactId, finished };
}

async function completeVerification(
  harness: Awaited<ReturnType<typeof setup>>,
  verdict: "verified" | "rejected",
  fallbackModel = "provider/model",
  controller = harness.controller,
  knowledgeFeedback?: "ambiguous_criteria" | "infeasible_design",
) {
  const assignment = await controller.startAssignment(undefined, fallbackModel);
  assert.equal(assignment.workflow, "verification");
  if (assignment.workflow !== "verification") assert.fail("verification assignment expected");
  assert(assignment.artifactPath);
  const failed = verdict === "rejected";
  const content = JSON.stringify({
    schemaVersion: 1,
    inputs: assignment.inputArtifacts?.map((artifact) => artifact.artifact_id),
    output: {
      kind: "verification_result",
      assignmentId: assignment.assignmentId,
      incrementId: assignment.incrementId,
      implementationArtifactId: assignment.implementationArtifactId,
      baseCommit: assignment.baseCommit,
      evaluatedCommit: assignment.evaluatedCommit,
      verdict,
      tests: [
        {
          command: "npm test",
          exitCode: 0,
          outputPath: `.xper/artifacts/test-output-${assignment.attemptId}-1.log`,
        },
      ],
      criteria: assignment.criteria.map((criterion) => ({
        criterionId: criterion.id,
        outcome: failed ? "failed" : "passed",
        evidence: failed ? "The observed behavior is wrong" : "The observed behavior passes",
        paths: ["src/change.ts"],
      })),
      review: {
        regressions: { outcome: "passed", evidence: "The suite passes", paths: [] },
        scope: { outcome: "passed", evidence: "The diff is focused", paths: ["src/change.ts"] },
        simplicity: {
          outcome: "passed",
          evidence: "The implementation is direct",
          paths: ["src/change.ts"],
        },
      },
      rejection: failed
        ? {
            cause: "acceptance criterion failed",
            evidence: "The exact evaluated revision returns the wrong value",
            paths: ["src/change.ts"],
            knowledgeFeedback: knowledgeFeedback ? { reason: knowledgeFeedback } : null,
          }
        : null,
    },
  });
  harness.artifacts.set(assignment.artifactPath, { content, digest: content });
  harness.artifacts.set(`.xper/artifacts/test-output-${assignment.attemptId}-1.log`, {
    content: "Synthetic test passed",
    digest: "synthetic-test-log",
  });
  const finished = await controller.finishAttempt({
    attemptId: assignment.attemptId,
    outcome: "succeeded",
    artifactPath: assignment.artifactPath,
  });
  assert.equal(finished.replayed, undefined);
  if (finished.replayed) assert.fail("new verification result expected");
  assert(finished.artifactId);
  return { assignment, artifactId: finished.artifactId, finished };
}

export {
  completeImplementation,
  completeVerification,
  fixtures,
  Recorder,
  sealPlan,
  sealTwoIncrementPlan,
  setup,
  twoIncrementOutputs,
};
