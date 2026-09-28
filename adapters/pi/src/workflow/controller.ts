import { createHash, randomUUID } from "node:crypto";
import type {
  RecorderClient,
  RecordedEvent,
  ResolvedConfiguration,
} from "../bridge/xper-client.js";
import { knowledgeDefinition } from "./definition.js";
import { readEvidence } from "./evidence.js";
import { WorkflowJournal } from "./journal.js";
import {
  completionNeedsEvidence,
  gateArtifact,
  transitionKnowledge,
  workflowPosition,
  type Evidence,
  type GateEvidence,
  type Transition,
} from "./knowledge-machine.js";
import { decodeCheckpoint, toRunSummary, type WorkflowState } from "./state.js";
import { WorkflowValidationError } from "./types.js";
import type {
  AssignmentStarted,
  AttemptFinished,
  FinishAttempt,
  ModelUsage,
  RoutingSnapshot,
  RunAdvanced,
  RunStatus,
  RunStarted,
  WorkflowClient,
  WorkflowPolicy,
} from "./types.js";
export type { WorkflowState } from "./state.js";

interface Options {
  configuration?: () => ResolvedConfiguration | null;
  now?: () => number;
  id?: () => string;
  readArtifact?: (path: string) => Promise<Evidence>;
}
function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

/** Local runtime: prepare evidence, apply a pure decision, checkpoint and enqueue telemetry. */
export class PiWorkflow implements WorkflowClient {
  private state: WorkflowState | null = null;
  private loaded = false;
  private stopping = false;
  private definitionRecorded = false;
  private tail: Promise<unknown> = Promise.resolve();
  private timeline: RecordedEvent[] = [];
  private readonly journal: WorkflowJournal;
  private readonly configuration: () => ResolvedConfiguration | null;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly readArtifact: (path: string) => Promise<Evidence>;
  constructor(
    recorder: Pick<RecorderClient, "appendEvents">,
    cwd: string,
    sessionId: string,
    options: Options = {},
  ) {
    this.journal = new WorkflowJournal(cwd, sessionId, recorder);
    this.configuration = options.configuration ?? (() => null);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.readArtifact = options.readArtifact ?? ((path) => readEvidence(cwd, path));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping)
      return Promise.reject(new WorkflowValidationError("Pi workflow has stopped"));
    const next = this.tail.then(async () => {
      await this.load();
      return operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private event(type: string, data: Record<string, unknown>, occurredAt: number): RecordedEvent {
    const state = this.requireRun();
    return {
      schemaVersion: 1,
      eventId: this.id(),
      runId: state.run_id,
      occurredAt,
      type,
      data: {
        ...data,
        definitionId: state.definition.id,
        definitionVersion: state.definition.version,
        instanceId: state.instanceId,
      },
    };
  }
  private async commit<Result>(transition: Transition<Result>, now: number): Promise<Result> {
    this.state = transition.state;
    if (!transition.facts.length) return structuredClone(transition.result);
    const state = this.requireRun();
    const facts = transition.facts.map((fact) => this.event(fact.type, fact.data, now));
    if (!this.definitionRecorded) {
      facts.unshift(this.event("workflow.definition", { definition: knowledgeDefinition }, now));
      this.definitionRecorded = true;
    }
    const content = JSON.stringify(state);
    let checkpoints: RecordedEvent[];
    if (Buffer.byteLength(content) < 28000)
      checkpoints = [
        this.event("adapter.state", { adapter: "pi", state: structuredClone(state) }, now),
      ];
    else {
      // Chunk by code points, then bytes, so Unicode survives a recording round trip.
      const chunks: string[] = [];
      let chunk = "";
      let bytes = 0;
      for (const character of content) {
        const size = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (bytes + size > 24000) {
          chunks.push(chunk);
          chunk = "";
          bytes = 0;
        }
        chunk += character;
        bytes += size;
      }
      if (chunk) chunks.push(chunk);
      const checkpointId = this.id();
      checkpoints = chunks.map((content, index) =>
        this.event(
          "adapter.state.chunk",
          {
            adapter: "pi",
            checkpointId,
            index,
            count: chunks.length,
            content,
          },
          now,
        ),
      );
    }
    const events = [...facts, ...checkpoints];
    this.timeline.push(...events);
    await this.journal.commit(state, events);
    return structuredClone(transition.result);
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.journal.load();
    this.state = decodeCheckpoint(this.journal.state);
    this.timeline = [...this.journal.pending];
    this.loaded = true;
    if (this.state) {
      const now = this.now();
      await this.commit(transitionKnowledge(this.state, { type: "session.recover" }, now), now);
    }
    this.journal.flush();
  }
  private requireRun(): WorkflowState {
    if (!this.state) invalid("start a workflow first");
    return this.state;
  }
  inspectProfile(): Promise<RoutingSnapshot | null> {
    return this.serial(async () =>
      structuredClone(this.state ? this.state.routing : (this.configuration()?.routing ?? null)),
    );
  }
  startRun(objective: string, policy?: WorkflowPolicy): Promise<RunStarted> {
    return this.serial(async () => {
      if (!this.state && !objective.trim()) invalid("workflow objective is required");
      const now = this.now();
      return this.commit(
        transitionKnowledge(
          this.state,
          {
            type: "run.start",
            runId: this.id(),
            instanceId: this.id(),
            visitId: this.id(),
            objectiveHash: createHash("sha256").update(objective).digest("hex"),
            configuration: structuredClone(
              this.configuration() ?? { routing: null, adapterConfig: {} },
            ),
            ...(policy ? { policy } : {}),
          },
          now,
        ),
        now,
      );
    });
  }
  startAssignment(assignmentId?: string): Promise<AssignmentStarted> {
    return this.serial(async () => {
      const event = {
        type: "assignment.start" as const,
        ...(assignmentId ? { assignmentId } : {}),
        newAssignmentId: this.id(),
        attemptId: this.id(),
      };
      const next = transitionKnowledge(this.requireRun(), event, this.now());
      // Admission is tentative until local evidence checks succeed. No state has changed yet.
      for (const input of next.result.inputArtifacts ?? []) await this.artifact(input.artifact_id);
      const now = this.now();
      return this.commit(transitionKnowledge(this.requireRun(), event, now), now);
    });
  }
  private async artifact(id: string): Promise<Evidence> {
    const artifact = this.requireRun().artifacts[id];
    if (!artifact) invalid("input artifact is not registered");
    const evidence = await this.readArtifact(artifact.path);
    if (evidence.digest !== artifact.digest) invalid("artifact changed after registration");
    return evidence;
  }
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished> {
    return this.serial(async () => {
      const state = this.requireRun(),
        now = this.now();
      let evidence: Evidence | undefined;
      if (completionNeedsEvidence(state, result, now) && result.outcome === "succeeded") {
        try {
          evidence = await this.readArtifact(result.artifactPath);
          const attempt = state.attempts[result.attemptId];
          const assignment = attempt && state.assignments[attempt.assignmentId];
          if (!assignment) invalid("assignment is not registered");
          for (const input of assignment.inputs) await this.artifact(input);
        } catch (error) {
          invalid(error instanceof Error ? error.message : "invalid artifact");
        }
      }
      return this.commit(
        transitionKnowledge(
          state,
          {
            type: "attempt.finish",
            result,
            artifactId: this.id(),
            ...(evidence ? { evidence } : {}),
          },
          now,
        ),
        now,
      );
    });
  }
  private async gateEvidence(state: WorkflowState): Promise<GateEvidence> {
    const artifact = gateArtifact(state);
    if (!artifact) return { artifacts: {} };
    const artifacts: Record<string, Evidence> = {};
    try {
      for (const id of new Set([
        artifact.artifact_id,
        ...artifact.inputs,
        ...Object.values(state.accepted),
      ]))
        artifacts[id] = await this.artifact(id);
      return { artifacts };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "artifact unavailable" };
    }
  }
  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced> {
    return this.serial(async () => {
      const state = this.requireRun();
      const evidence = await this.gateEvidence(state);
      const now = this.now();
      return this.commit(
        transitionKnowledge(
          state,
          {
            type: "gate.evaluate",
            nextVisitId: this.id(),
            evidence,
            ...(approvedArtifactId ? { approvedArtifactId } : {}),
          },
          now,
        ),
        now,
      );
    });
  }
  recordUsage(attemptId: string, usage: ModelUsage): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      await this.commit(
        transitionKnowledge(this.requireRun(), { type: "usage.record", attemptId, usage }, now),
        now,
      );
    });
  }
  /** Finish queued local work; never wait for recording RPCs. */
  async stopRecording(): Promise<void> {
    this.stopping = true;
    this.journal.stop();
    await this.tail;
    await this.journal.close();
  }
  syncRecording(): void {
    this.journal.flush();
  }
  /** Explicit test/diagnostic synchronization, outside workflow execution. */
  waitForRecording(): Promise<void> {
    this.journal.flush();
    return this.journal.waitForIdle();
  }
  getRunStatus(): Promise<RunStatus> {
    return this.serial(async () => {
      this.journal.flush();
      return {
        run: this.state ? toRunSummary(this.state) : null,
        ...(this.state ? { workflow: workflowPosition(this.state) } : {}),
        timeline: structuredClone(this.timeline),
        durability: this.journal.durability,
        ...(this.journal.problem ? { degradedReason: this.journal.problem } : {}),
      };
    });
  }
}
