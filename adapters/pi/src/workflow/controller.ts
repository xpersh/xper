import { createHash, randomUUID } from "node:crypto";
import { object, type RecorderClient, type RecordedEvent } from "../bridge/xper-client.js";
import { parseDocument, validateLinks, type Document } from "./contracts.js";
import { readEvidence } from "./evidence.js";
import { WorkflowJournal } from "./journal.js";
import {
  admit,
  budgetRemaining,
  contracts,
  feedbackTargets,
  phases,
  policyFrom,
  type Phase,
  type Policy,
} from "./policy.js";
import { WorkflowValidationError } from "./types.js";
import type {
  ModelUsage,
  ArtifactInput,
  AssignmentStarted,
  AttemptFinished,
  AvailableModel,
  FinishAttempt,
  ModelSelection,
  RoutingSnapshot,
  RunAdvanced,
  RunStatus,
  RunStarted,
  WorkflowClient,
  WorkflowPolicy,
} from "./types.js";

interface Assignment {
  id: string;
  visitId: string;
  phase: Phase;
  role: string;
  inputs: string[];
  selection: ModelSelection | null;
  attemptIds: string[];
}
interface Attempt {
  assignmentId: string;
  startedAt: number;
  timeoutMs: number;
  outcome: FinishAttempt["outcome"] | "interrupted" | null;
  artifactId: string | null;
  artifactPath: string;
  selection: ModelSelection | null;
}
interface Artifact extends ArtifactInput {
  attemptId: string;
  digest: string;
  inputs: string[];
}
export interface WorkflowState {
  version: 1;
  revision: number;
  run_id: string;
  startedAt: number;
  routing: RoutingSnapshot | null;
  policy: Policy;
  visits: Array<{ id: string; phase: Phase }>;
  assignments: Record<string, Assignment>;
  attempts: Record<string, Attempt>;
  artifacts: Record<string, Artifact>;
  accepted: Partial<Record<Phase, string>>;
  feedback: string | null;
  human_input: [string, string] | null;
  ready: boolean;
}
interface Options {
  now?: () => number;
  id?: () => string;
  readArtifact?: (path: string) => Promise<{ content: string; digest: string }>;
}
function validState(value: unknown): value is WorkflowState {
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const selection = (v: unknown) =>
    v === null || (object(v) && [v.context, v.provider, v.model, v.thinking].every(text));
  if (
    !object(value) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !text(value.run_id) ||
    !integer(value.startedAt) ||
    typeof value.ready !== "boolean" ||
    !object(value.policy) ||
    !Array.isArray(value.visits) ||
    !value.visits.length ||
    !object(value.assignments) ||
    !object(value.attempts) ||
    !object(value.artifacts) ||
    !object(value.accepted)
  )
    return false;
  try {
    policyFrom(value.policy);
  } catch {
    return false;
  }
  if (
    value.routing !== null &&
    (!object(value.routing) ||
      !text(value.routing.profile) ||
      !text(value.routing.context) ||
      !object(value.routing.routes) ||
      !Object.values(value.routing.routes).every(
        (v) =>
          Array.isArray(v) && v.length > 0 && v.every((item) => item !== null && selection(item)),
      ))
  )
    return false;
  if (!value.visits.every((v) => object(v) && text(v.id) && phases.includes(v.phase as Phase)))
    return false;
  const visits = new Set(value.visits.map((v) => (v as { id: string }).id));
  const { assignments, attempts, artifacts } = value;
  if (
    !Object.entries(assignments).every(
      ([id, a]) =>
        object(a) &&
        a.id === id &&
        visits.has(String(a.visitId)) &&
        phases.includes(a.phase as Phase) &&
        text(a.role) &&
        strings(a.inputs) &&
        strings(a.attemptIds) &&
        selection(a.selection),
    )
  )
    return false;
  if (
    !Object.values(attempts).every(
      (a) =>
        object(a) &&
        text(a.assignmentId) &&
        Object.hasOwn(assignments, a.assignmentId) &&
        integer(a.startedAt) &&
        integer(a.timeoutMs) &&
        Number(a.timeoutMs) > 0 &&
        (a.outcome === null ||
          ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
            String(a.outcome),
          )) &&
        (a.artifactId === null || (text(a.artifactId) && Object.hasOwn(artifacts, a.artifactId))) &&
        text(a.artifactPath) &&
        selection(a.selection),
    )
  )
    return false;
  if (
    !Object.entries(artifacts).every(
      ([id, a]) =>
        object(a) &&
        a.artifact_id === id &&
        text(a.attemptId) &&
        Object.hasOwn(attempts, a.attemptId) &&
        text(a.kind) &&
        text(a.path) &&
        a.version === 1 &&
        text(a.digest) &&
        strings(a.inputs) &&
        a.inputs.every((input) => Object.hasOwn(artifacts, input)),
    )
  )
    return false;
  if (
    !Object.values(assignments).every(
      (a) =>
        object(a) &&
        strings(a.inputs) &&
        a.inputs.every((id) => Object.hasOwn(artifacts, id)) &&
        strings(a.attemptIds) &&
        a.attemptIds.every((id) => Object.hasOwn(attempts, id)),
    )
  )
    return false;
  if (
    !Object.entries(value.accepted).every(
      ([phase, id]) => phases.includes(phase as Phase) && text(id) && Object.hasOwn(artifacts, id),
    )
  )
    return false;
  if (
    value.feedback !== null &&
    (!text(value.feedback) || !Object.hasOwn(artifacts, value.feedback))
  )
    return false;
  return (
    value.human_input === null ||
    (strings(value.human_input) &&
      value.human_input.length === 2 &&
      visits.has(value.human_input[0] ?? "") &&
      Object.hasOwn(artifacts, value.human_input[1] ?? ""))
  );
}

function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}
/** Pi owns workflow decisions; Xper only stores the facts and opaque checkpoints. */
export class PiWorkflow implements WorkflowClient {
  private state: WorkflowState | null = null;
  private loaded = false;
  private legacy = false;
  private tail: Promise<unknown> = Promise.resolve();
  private timeline: RecordedEvent[] = [];
  private readonly journal: WorkflowJournal;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly readArtifact: (path: string) => Promise<{ content: string; digest: string }>;
  constructor(
    private readonly recorder: RecorderClient,
    cwd: string,
    sessionId: string,
    options: Options = {},
  ) {
    this.journal = new WorkflowJournal(cwd, sessionId, recorder);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.readArtifact = options.readArtifact ?? ((path) => readEvidence(cwd, path));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      await this.load();
      return operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private event(type: string, data: Record<string, unknown>): RecordedEvent {
    return {
      schemaVersion: 1,
      eventId: this.id(),
      runId: this.requireRun().run_id,
      occurredAt: this.now(),
      type,
      data,
    };
  }
  private async commit(facts: RecordedEvent[]): Promise<void> {
    const state = this.requireRun();
    state.revision++;
    const content = JSON.stringify(state);
    let checkpoints: RecordedEvent[];
    if (Buffer.byteLength(content) < 28000)
      checkpoints = [this.event("adapter.state", { adapter: "pi", state: structuredClone(state) })];
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
        this.event("adapter.state.chunk", {
          adapter: "pi",
          checkpointId,
          index,
          count: chunks.length,
          content,
        }),
      );
    }
    const events = [...facts, ...checkpoints];
    this.timeline.push(...events);
    await this.journal.commit(state, events);
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.journal.load();
    if (this.journal.state !== null && !validState(this.journal.state))
      invalid("unsupported Pi checkpoint; preserve the journal and inspect the recorded run");
    this.state = this.journal.state as WorkflowState | null;
    try {
      const status = await this.recorder.getRunStatus(this.state?.run_id);
      this.journal.durability = status.durability;
      this.timeline = status.timeline;
      const chunks = new Map<string, { parts: string[]; count: number }>();
      for (const event of status.timeline) {
        let candidate: unknown;
        if (event.type === "adapter.state" && event.data.adapter === "pi")
          candidate = event.data.state;
        if (event.type === "adapter.state.chunk" && event.data.adapter === "pi") {
          const { checkpointId, index, count, content } = event.data;
          if (
            typeof checkpointId === "string" &&
            Number.isSafeInteger(index) &&
            Number.isSafeInteger(count) &&
            Number(count) > 0 &&
            Number(count) <= 1024 &&
            Number(index) >= 0 &&
            Number(index) < Number(count) &&
            typeof content === "string"
          ) {
            const group = chunks.get(checkpointId) ?? { parts: [], count: Number(count) };
            group.parts[Number(index)] = content;
            chunks.set(checkpointId, group);
            if (group.parts.filter((p) => typeof p === "string").length === group.count) {
              try {
                candidate = JSON.parse(group.parts.join(""));
              } catch {
                /* Incomplete checkpoints never replace usable state. */
              }
            }
          }
        }
        if (
          validState(candidate) &&
          candidate.run_id === event.runId &&
          (!this.state || candidate.revision > this.state.revision)
        )
          this.state = candidate;
      }
      this.legacy = status.run !== null && this.state === null;
    } catch (error) {
      if (!this.state) throw error;
      this.journal.problem = "recorder unavailable; using the local Pi checkpoint";
    }
    this.loaded = true;
    const recovered: RecordedEvent[] = [];
    for (const [attemptId, attempt] of Object.entries(this.state?.attempts ?? {}))
      if (attempt.outcome === null) {
        attempt.outcome = "interrupted";
        recovered.push(
          this.event("attempt.finished", {
            attemptId,
            outcome: "interrupted",
            assignmentId: attempt.assignmentId,
          }),
        );
      }
    if (recovered.length) await this.commit(recovered);
    else await this.journal.flush();
  }
  private requireRun(): WorkflowState {
    if (!this.state)
      invalid(
        this.legacy
          ? "legacy core-owned run is inspectable but cannot resume without a Pi checkpoint; start a new Pi session"
          : "start a workflow first",
      );
    return this.state;
  }
  private visit() {
    const visit = this.requireRun().visits.at(-1);
    if (!visit) invalid("no active knowledge phase");
    return visit;
  }
  private budget() {
    const s = this.requireRun();
    return budgetRemaining(s.policy, s.startedAt, this.now(), Object.keys(s.attempts).length);
  }
  inspectProfile(): Promise<RoutingSnapshot | null> {
    return this.recorder.inspectProfile();
  }
  startRun(
    objective: string,
    models?: AvailableModel[],
    policy?: WorkflowPolicy,
  ): Promise<RunStarted> {
    return this.serial(async () => {
      if (this.state) return { runId: this.state.run_id, phase: this.visit().phase, resumed: true };
      if (this.legacy) this.requireRun();
      if (!objective.trim()) invalid("workflow objective is required");
      const config = await this.recorder.resolveConfiguration(models);
      const selectedPolicy = policyFrom(policy ?? (config.adapterConfig as WorkflowPolicy));
      if (config.routing && !config.routing.routes[contracts.discovery.role]?.length)
        invalid("active profile has no Discovery route");
      this.state = {
        version: 1,
        revision: 0,
        run_id: this.id(),
        startedAt: this.now(),
        routing: config.routing,
        policy: selectedPolicy,
        visits: [{ id: this.id(), phase: "discovery" }],
        assignments: {},
        attempts: {},
        artifacts: {},
        accepted: {},
        feedback: null,
        human_input: null,
        ready: false,
      };
      await this.commit([
        this.event("run.started", {
          workflow: "pi.knowledge.v1",
          objectiveHash: createHash("sha256").update(objective).digest("hex"),
          routing: config.routing,
        }),
        this.event("phase.entered", { phase: "discovery", visitId: this.visit().id }),
      ]);
      return { runId: this.state.run_id, phase: "discovery", resumed: false };
    });
  }
  startAssignment(assignmentId?: string): Promise<AssignmentStarted> {
    return this.serial(async () => {
      const s = this.requireRun(),
        visit = this.visit();
      if (s.ready) invalid("implementation is not available; the execution plan is ready");
      const running = Object.values(s.attempts).filter((a) => a.outcome === null).length;
      admit(s.policy, this.budget(), running);
      let assignment: Assignment;
      const facts: RecordedEvent[] = [];
      if (assignmentId) {
        const existing = s.assignments[assignmentId];
        if (
          !existing ||
          existing.visitId !== visit.id ||
          s.attempts[existing.attemptIds.at(-1) ?? ""]?.outcome !== "interrupted"
        )
          invalid("only an interrupted assignment from the current visit can be retried");
        assignment = existing;
      } else {
        const role = contracts[visit.phase].role;
        const selection = s.routing?.routes[role]?.[0] ?? null;
        if (s.routing && !selection) invalid(`active profile has no route for ${role}`);
        assignment = {
          id: this.id(),
          visitId: visit.id,
          phase: visit.phase,
          role,
          inputs: [
            ...new Set([...Object.values(s.accepted), ...(s.feedback ? [s.feedback] : [])]),
          ].sort(),
          selection,
          attemptIds: [],
        };
        facts.push(
          this.event("assignment.created", {
            assignmentId: assignment.id,
            visitId: visit.id,
            role,
            inputs: assignment.inputs,
          }),
        );
      }
      for (const input of assignment.inputs) await this.artifact(input);
      s.assignments[assignment.id] = assignment;
      if (s.human_input) {
        facts.push(
          this.event("human.wait.finished", {
            visitId: s.human_input[0],
            artifactId: s.human_input[1],
            reason: "superseded",
          }),
        );
        s.human_input = null;
      }
      const attemptId = this.id();
      const artifactPath =
        visit.phase === "discovery"
          ? `.xper/artifacts/discovery-brief-${attemptId}.md`
          : `.xper/artifacts/${contracts[visit.phase].kind.replaceAll("_", "-")}-${attemptId}.json`;
      const timeoutMs = Math.min(s.policy.attemptTimeMs, this.budget().timeMs);
      s.attempts[attemptId] = {
        assignmentId: assignment.id,
        startedAt: this.now(),
        timeoutMs,
        outcome: null,
        artifactId: null,
        artifactPath,
        selection: assignment.selection,
      };
      assignment.attemptIds.push(attemptId);
      facts.push(
        this.event("attempt.started", {
          attemptId,
          assignmentId: assignment.id,
          visitId: visit.id,
          role: assignment.role,
          selection: assignment.selection,
          timeoutMs,
        }),
      );
      if (assignment.selection)
        facts.push(this.event("model.resolved", { attemptId, ...assignment.selection }));
      await this.commit(facts);
      return {
        runId: s.run_id,
        assignmentId: assignment.id,
        attemptId,
        role: assignment.role,
        selection: assignment.selection,
        phase: visit.phase,
        artifactKind: contracts[visit.phase].kind,
        artifactPath,
        inputArtifacts: assignment.inputs.map((id) => {
          const a = s.artifacts[id];
          if (!a) invalid("input artifact unavailable");
          return { artifact_id: a.artifact_id, kind: a.kind, path: a.path, version: a.version };
        }),
        timeoutMs,
        budget: this.budget(),
      };
    });
  }
  private async artifact(id: string): Promise<{ artifact: Artifact; content: string }> {
    const artifact = this.requireRun().artifacts[id];
    if (!artifact) invalid("input artifact is not registered");
    const evidence = await this.readArtifact(artifact.path);
    if (evidence.digest !== artifact.digest) invalid("artifact changed after registration");
    return { artifact, content: evidence.content };
  }
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished> {
    return this.serial(async () => {
      const s = this.requireRun(),
        attempt = s.attempts[result.attemptId];
      if (!attempt) invalid("attempt is not registered");
      if (attempt.outcome !== null) {
        if (
          attempt.outcome !== result.outcome &&
          !(result.outcome === "succeeded" && attempt.outcome === "timed_out")
        )
          invalid("attempt already has a different outcome");
        if (result.outcome === "succeeded" && result.artifactPath !== attempt.artifactPath)
          invalid("artifact path does not match the assignment");
        return {
          attemptId: result.attemptId,
          outcome: attempt.outcome as FinishAttempt["outcome"],
          replayed: true,
        };
      }
      let outcome = result.outcome;
      if (
        outcome === "succeeded" &&
        (this.now() - attempt.startedAt >= attempt.timeoutMs || !this.budget().timeMs)
      )
        outcome = "timed_out";
      const assignment = s.assignments[attempt.assignmentId];
      if (!assignment) invalid("assignment is not registered");
      const facts: RecordedEvent[] = [];
      if (result.outcome === "succeeded" && outcome === "succeeded") {
        try {
          if (result.artifactPath !== attempt.artifactPath)
            invalid("artifact path does not match the assignment");
          const { content, digest } = await this.readArtifact(result.artifactPath);
          const document =
            assignment.phase === "discovery" ? null : parseDocument(content, assignment.inputs);
          const kind = document?.output.kind ?? "discovery_brief";
          if (kind !== contracts[assignment.phase].kind && kind !== "feedback")
            invalid("artifact kind does not match the current phase");
          for (const input of assignment.inputs) await this.artifact(input);
          const artifactId = this.id();
          s.artifacts[artifactId] = {
            artifact_id: artifactId,
            attemptId: result.attemptId,
            kind,
            path: result.artifactPath,
            version: 1,
            digest,
            inputs: [...assignment.inputs],
          };
          attempt.artifactId = artifactId;
          facts.push(
            this.event("artifact.registered", {
              artifactId,
              attemptId: result.attemptId,
              kind,
              path: result.artifactPath,
              digest,
              inputs: assignment.inputs,
            }),
          );
        } catch (error) {
          // Local validation rejects before the attempt is settled; the action can report failure.
          throw new WorkflowValidationError(
            error instanceof Error ? error.message : "invalid artifact",
          );
        }
      }
      attempt.outcome = outcome;
      facts.push(
        this.event("attempt.finished", {
          attemptId: result.attemptId,
          assignmentId: attempt.assignmentId,
          outcome,
          durationMs: Math.max(0, this.now() - attempt.startedAt),
        }),
      );
      await this.commit(facts);
      return { attemptId: result.attemptId, outcome, artifactId: attempt.artifactId };
    });
  }
  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced> {
    return this.serial(async () => {
      const s = this.requireRun(),
        visit = this.visit(),
        phase = visit.phase;
      const blocked = async (reason: string, humanArtifactId?: string): Promise<RunAdvanced> => {
        await this.commit([this.event("gate.failed", { phase, visitId: visit.id, reason })]);
        return { advanced: false, phase, reason, ...(humanArtifactId ? { humanArtifactId } : {}) };
      };
      if (!this.budget().timeMs) return blocked("run time budget exhausted");
      if (Object.values(s.attempts).some((a) => a.outcome === null))
        return blocked("an attempt is still running");
      const artifact = Object.values(s.artifacts)
        .reverse()
        .find((a) => {
          const attempt = s.attempts[a.attemptId];
          return (
            attempt?.outcome === "succeeded" &&
            s.assignments[attempt.assignmentId]?.visitId === visit.id
          );
        });
      if (!artifact) return blocked("a successful phase artifact is required");
      if (
        approvedArtifactId &&
        (!s.human_input ||
          s.human_input[0] !== visit.id ||
          s.human_input[1] !== approvedArtifactId ||
          approvedArtifactId !== artifact.artifact_id)
      )
        invalid("approval does not match the pending visit and artifact");
      let document: Document | undefined;
      try {
        const evidence = await this.artifact(artifact.artifact_id);
        for (const input of artifact.inputs) await this.artifact(input);
        if (phase !== "discovery") document = parseDocument(evidence.content, artifact.inputs);
        if (document?.output.kind === "feedback") {
          const target = feedbackTargets[document.output.reason];
          if (!target || phases.indexOf(target) >= phases.indexOf(phase))
            return blocked("feedback must identify an earlier responsible phase");
          for (const accepted of phases.slice(phases.indexOf(target))) delete s.accepted[accepted];
          s.feedback = artifact.artifact_id;
          s.human_input = null;
          const next = { id: this.id(), phase: target };
          s.visits.push(next);
          await this.commit([
            this.event("phase.exited", { phase, visitId: visit.id }),
            this.event("phase.revisited", {
              phase: target,
              from: phase,
              reason: document.output.reason,
              artifactId: artifact.artifact_id,
            }),
            this.event("phase.entered", { phase: target, visitId: next.id }),
          ]);
          return { advanced: true, phase: target };
        }
        if (document?.output.kind === "design_decisions" && !document.output.feasible)
          return blocked("design is not feasible; provide evidence-backed feedback");
        const upstream: Partial<Record<string, Document>> = {};
        for (const [inputPhase, id] of Object.entries(s.accepted)) {
          const input = await this.artifact(id);
          if (inputPhase !== "discovery")
            upstream[inputPhase] = parseDocument(input.content, input.artifact.inputs);
        }
        if (document) validateLinks(document.output, upstream, this.budget());
      } catch (error) {
        return blocked(error instanceof Error ? error.message : "artifact unavailable");
      }
      if (s.ready) return { advanced: true, phase, ready: true, resumed: true };
      const facts: RecordedEvent[] = [];
      if (s.policy.humanGates.includes(phase)) {
        if (!approvedArtifactId) {
          if (!s.human_input) {
            s.human_input = [visit.id, artifact.artifact_id];
            await this.commit([
              this.event("human.wait.started", {
                phase,
                visitId: visit.id,
                artifactId: artifact.artifact_id,
              }),
            ]);
          }
          return {
            advanced: false,
            phase,
            reason: "human approval required",
            humanArtifactId: artifact.artifact_id,
          };
        }
        facts.push(
          this.event("human.approved", {
            phase,
            visitId: visit.id,
            artifactId: approvedArtifactId,
          }),
          this.event("human.wait.finished", { visitId: visit.id, artifactId: approvedArtifactId }),
        );
      }
      s.accepted[phase] = artifact.artifact_id;
      s.feedback = null;
      s.human_input = null;
      facts.push(
        this.event("gate.passed", { phase, visitId: visit.id, artifactId: artifact.artifact_id }),
      );
      const next = phases[phases.indexOf(phase) + 1];
      if (next) {
        const nextVisit = { id: this.id(), phase: next };
        s.visits.push(nextVisit);
        facts.push(
          this.event("phase.exited", { phase, visitId: visit.id }),
          this.event("phase.entered", { phase: next, visitId: nextVisit.id }),
        );
      } else {
        s.ready = true;
        facts.push(this.event("run.status", { status: "ready" }));
      }
      await this.commit(facts);
      return { advanced: true, phase: next ?? phase, ...(!next ? { ready: true } : {}) };
    });
  }
  recordUsage(attemptId: string, usage: ModelUsage): Promise<void> {
    return this.serial(async () => {
      if (!this.requireRun().attempts[attemptId]) invalid("attempt is not registered");
      const data: Record<string, unknown> = { attemptId };
      for (const key of [
        "inputTokens",
        "outputTokens",
        "costMicros",
        "cacheReadTokens",
        "cacheWriteTokens",
      ] as const) {
        const value = usage[key];
        if (value === null || (Number.isSafeInteger(value) && Number(value) >= 0))
          data[key] = value;
      }
      if (usage.provider) data.provider = usage.provider;
      if (usage.model) data.model = usage.model;
      if (usage.costSource) data.costSource = usage.costSource;
      await this.commit([this.event("model.usage", data)]);
    });
  }
  getRunStatus(): Promise<RunStatus> {
    return this.serial(async () => {
      await this.journal.flush();
      return {
        run: this.state ? structuredClone(this.state) : null,
        timeline: this.timeline,
        durability: this.journal.durability,
        ...(this.journal.problem ? { degradedReason: this.journal.problem } : {}),
        ...(this.legacy
          ? {
              degradedReason:
                "legacy core-owned run cannot resume without a Pi checkpoint; use xper status to inspect it",
            }
          : {}),
      };
    });
  }
}
