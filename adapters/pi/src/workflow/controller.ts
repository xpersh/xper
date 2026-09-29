import { createHash, randomUUID } from "node:crypto";
import type {
  RecorderClient,
  RecordedEvent,
  ResolvedConfiguration,
} from "../bridge/xper-client.js";
import { inspectGitWorkspace, type GitWorkspace } from "../implementation/workspace.js";
import {
  parseDocument,
  selectNextImplementationHandoff,
  selectVerificationHandoff,
  validateLinks,
  type PlannedAssignment,
} from "./contracts.js";
import {
  implementationDefinition,
  knowledgeDefinition,
  verificationDefinition,
} from "./definition.js";
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
import {
  implementationPosition,
  parseImplementationResult,
  transitionImplementation,
  type ImplementationState,
} from "./implementation.js";
import { budgetRemaining } from "./policy.js";
import {
  decodeAdapterCheckpoint,
  toRunSummary,
  verifiedDeliveryTip,
  type AdapterCheckpoint,
  type WorkflowState,
} from "./state.js";
import { WorkflowValidationError } from "./types.js";
import type {
  AttemptFinished,
  FinishAttempt,
  ModelUsage,
  RoutingSnapshot,
  RunAdvanced,
  RunStatus,
  RunStarted,
  StartedAssignment,
  WorkflowClient,
  WorkflowPolicy,
  RemainingBudget,
} from "./types.js";
import {
  transitionVerification,
  verificationPosition,
  type VerificationState,
} from "./verification.js";
export type { WorkflowState } from "./state.js";

interface Options {
  configuration?: () => ResolvedConfiguration | null;
  now?: () => number;
  id?: () => string;
  readArtifact?: (path: string) => Promise<Evidence>;
  inspectWorkspace?: (cwd: string) => Promise<GitWorkspace>;
}
function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

type DeliveryFrontier =
  | {
      kind: "implementation";
      implementation: ImplementationState;
      rejected?: VerificationState;
    }
  | {
      kind: "verification";
      implementation: ImplementationState;
      verification?: VerificationState;
    };

/** Local runtime: prepare evidence, apply a pure decision, checkpoint and enqueue telemetry. */
export class PiWorkflow implements WorkflowClient {
  private state: AdapterCheckpoint | null = null;
  private loaded = false;
  private stopping = false;
  private readonly definitionsRecorded = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private timeline: RecordedEvent[] = [];
  private readonly journal: WorkflowJournal;
  private readonly configuration: () => ResolvedConfiguration | null;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly readArtifact: (path: string) => Promise<Evidence>;
  private readonly inspectWorkspace: (cwd: string) => Promise<GitWorkspace>;
  private readonly cwd: string;
  constructor(
    recorder: Pick<RecorderClient, "appendEvents">,
    cwd: string,
    sessionId: string,
    options: Options = {},
  ) {
    this.cwd = cwd;
    this.journal = new WorkflowJournal(cwd, sessionId, recorder);
    this.configuration = options.configuration ?? (() => null);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.readArtifact = options.readArtifact ?? ((path) => readEvidence(cwd, path));
    this.inspectWorkspace = options.inspectWorkspace ?? inspectGitWorkspace;
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
  private event(
    type: string,
    data: Record<string, unknown>,
    occurredAt: number,
    context: {
      runId: string;
      definition: { id: string; version: number };
      instanceId: string;
    },
  ): RecordedEvent {
    return {
      schemaVersion: 1,
      eventId: this.id(),
      runId: context.runId,
      occurredAt,
      type,
      data: {
        ...data,
        definitionId: context.definition.id,
        definitionVersion: context.definition.version,
        instanceId: context.instanceId,
      },
    };
  }
  private async persist<Result>(
    factsInput: Array<{ type: string; data: Record<string, unknown> }>,
    result: Result,
    now: number,
    definition:
      | typeof knowledgeDefinition
      | typeof implementationDefinition
      | typeof verificationDefinition,
    context: { runId: string; instanceId: string },
  ): Promise<Result> {
    const state = this.requireRun();
    if (!factsInput.length) return structuredClone(result);
    const eventContext = {
      runId: context.runId,
      definition: { id: definition.id, version: definition.version },
      instanceId: context.instanceId,
    };
    const facts = factsInput.map((fact) => this.event(fact.type, fact.data, now, eventContext));
    const definitionKey = `${definition.id}@${definition.version}`;
    if (!this.definitionsRecorded.has(definitionKey)) {
      facts.unshift(this.event("workflow.definition", { definition }, now, eventContext));
      this.definitionsRecorded.add(definitionKey);
    }
    const content = JSON.stringify(state);
    let checkpoints: RecordedEvent[];
    if (Buffer.byteLength(content) < 28000)
      checkpoints = [
        this.event(
          "adapter.state",
          { adapter: "pi", state: structuredClone(state) },
          now,
          eventContext,
        ),
      ];
    else {
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
          { adapter: "pi", checkpointId, index, count: chunks.length, content },
          now,
          eventContext,
        ),
      );
    }
    const events = [...facts, ...checkpoints];
    this.timeline.push(...events);
    await this.journal.commit(state, events);
    return structuredClone(result);
  }
  private async commitKnowledge<Result>(
    transition: Transition<Result>,
    now: number,
  ): Promise<Result> {
    if (this.state) this.state.knowledge = transition.state;
    else
      this.state = {
        version: 4,
        knowledge: transition.state,
        implementations: {},
        verifications: {},
      };
    if (!transition.facts.length) return structuredClone(transition.result);
    return this.persist(transition.facts, transition.result, now, knowledgeDefinition, {
      runId: transition.state.run_id,
      instanceId: transition.state.instanceId,
    });
  }
  private async commitImplementation<Result>(
    transition: import("./implementation.js").ImplementationTransition<Result>,
    now: number,
  ): Promise<Result> {
    const checkpoint = this.requireRun();
    let history = checkpoint.implementations[transition.state.incrementId];
    if (!history) {
      history = [];
      checkpoint.implementations[transition.state.incrementId] = history;
    }
    const index = history.findIndex((state) => state.instanceId === transition.state.instanceId);
    if (index >= 0) history[index] = transition.state;
    else history.push(transition.state);
    return this.persist(transition.facts, transition.result, now, implementationDefinition, {
      runId: transition.state.runId,
      instanceId: transition.state.instanceId,
    });
  }
  private async commitVerification<Result>(
    transition: import("./verification.js").VerificationTransition<Result>,
    now: number,
  ): Promise<Result> {
    const checkpoint = this.requireRun();
    let history = checkpoint.verifications[transition.state.incrementId];
    if (!history) {
      history = [];
      checkpoint.verifications[transition.state.incrementId] = history;
    }
    const index = history.findIndex((state) => state.instanceId === transition.state.instanceId);
    if (index >= 0) history[index] = transition.state;
    else history.push(transition.state);
    return this.persist(transition.facts, transition.result, now, verificationDefinition, {
      runId: transition.state.runId,
      instanceId: transition.state.instanceId,
    });
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.journal.load();
    this.state = decodeAdapterCheckpoint(this.journal.state);
    this.timeline = [...this.journal.pending];
    this.loaded = true;
    if (this.state) {
      const now = this.now();
      await this.commitKnowledge(
        transitionKnowledge(this.state.knowledge, { type: "session.recover" }, now),
        now,
      );
      for (const history of Object.values(this.state.implementations))
        for (const implementation of history)
          await this.commitImplementation(
            transitionImplementation(implementation, { type: "session.recover" }, now),
            now,
          );
      for (const history of Object.values(this.state.verifications))
        for (const verification of history)
          await this.commitVerification(
            transitionVerification(verification, { type: "session.recover" }, now),
            now,
          );
    }
    this.journal.flush();
  }
  private requireRun(): AdapterCheckpoint {
    if (!this.state) invalid("start a workflow first");
    return this.state;
  }
  private knowledge(): WorkflowState {
    return this.requireRun().knowledge;
  }
  inspectProfile(): Promise<RoutingSnapshot | null> {
    return this.serial(async () =>
      structuredClone(
        this.state ? this.state.knowledge.routing : (this.configuration()?.routing ?? null),
      ),
    );
  }
  startRun(objective: string, policy?: WorkflowPolicy): Promise<RunStarted> {
    return this.serial(async () => {
      if (!this.state && !objective.trim()) invalid("workflow objective is required");
      const now = this.now();
      return this.commitKnowledge(
        transitionKnowledge(
          this.state?.knowledge ?? null,
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
  private runBudget(now: number) {
    const checkpoint = this.requireRun();
    const knowledge = checkpoint.knowledge;
    const attempts =
      Object.keys(knowledge.attempts).length +
      Object.values(checkpoint.implementations).reduce(
        (total, history) =>
          total +
          history.reduce(
            (subtotal, implementation) => subtotal + Object.keys(implementation.attempts).length,
            0,
          ),
        0,
      ) +
      Object.values(checkpoint.verifications).reduce(
        (total, history) =>
          total +
          history.reduce(
            (subtotal, verification) => subtotal + Object.keys(verification.attempts).length,
            0,
          ),
        0,
      );
    return budgetRemaining(knowledge.policy, knowledge.startedAt, now, attempts);
  }
  private assignmentBudget(
    assignment: PlannedAssignment,
    history: Array<ImplementationState | VerificationState>,
    now: number,
  ): RemainingBudget {
    const attempts = history.reduce(
      (total, state) => total + Object.keys(state.attempts).length,
      0,
    );
    const startedAt = history[0]?.startedAt ?? now;
    const attemptCostMicros =
      history[0]?.attemptCostMicros ?? this.knowledge().policy.attemptCostMicros;
    return {
      attempts: Math.max(0, assignment.maxAttempts - attempts),
      timeMs: Math.max(0, assignment.maxTimeMs - Math.max(0, now - startedAt)),
      costMicros: Math.max(0, assignment.maxCostMicros - attempts * attemptCostMicros),
      concurrency: 1,
    };
  }
  private deliveryFrontier(): DeliveryFrontier | null {
    const checkpoint = this.requireRun();
    const frontiers: DeliveryFrontier[] = [];
    for (const [incrementId, history] of Object.entries(checkpoint.implementations)) {
      const implementation = history.at(-1);
      if (!implementation) invalid("implementation history is empty");
      if (implementation.lifecycle.status === "active") {
        frontiers.push({ kind: "implementation", implementation });
        continue;
      }
      const verification = (checkpoint.verifications[incrementId] ?? []).findLast(
        (candidate) => candidate.implementation.instanceId === implementation.instanceId,
      );
      if (!verification || verification.lifecycle.status === "active") {
        frontiers.push({
          kind: "verification",
          implementation,
          ...(verification ? { verification } : {}),
        });
        continue;
      }
      if (verification.lifecycle.verdict === "rejected")
        frontiers.push({ kind: "implementation", implementation, rejected: verification });
    }
    if (frontiers.length > 1) invalid("delivery checkpoint has overlapping increment frontiers");
    return frontiers[0] ?? null;
  }
  private satisfiedAssignmentArtifacts(): Map<string, string> {
    const checkpoint = this.requireRun();
    const satisfied = new Map<string, string>();
    for (const [incrementId, history] of Object.entries(checkpoint.implementations)) {
      const implementation = history.at(-1);
      if (implementation?.lifecycle.status !== "completed") continue;
      satisfied.set(implementation.assignment.id, implementation.lifecycle.artifactId);
      const verification = (checkpoint.verifications[incrementId] ?? []).findLast(
        (candidate) => candidate.implementation.instanceId === implementation.instanceId,
      );
      if (verification?.lifecycle.status !== "completed") continue;
      if (verification.lifecycle.verdict !== "verified") continue;
      satisfied.set(verification.assignment.id, verification.lifecycle.artifactId);
    }
    return satisfied;
  }
  private async implementationHandoff(now: number) {
    const knowledge = this.knowledge();
    if (knowledge.lifecycle.status !== "completed") invalid("the execution Plan is not sealed");
    const documents: Partial<Record<string, ReturnType<typeof parseDocument>>> = {};
    for (const [phase, id] of Object.entries(knowledge.accepted)) {
      const artifact = knowledge.artifacts[id];
      if (!artifact) invalid("accepted knowledge artifact is not registered");
      const evidence = await this.artifact(id);
      if (phase !== "discovery") {
        try {
          documents[phase] = parseDocument(evidence.content, artifact.inputs);
        } catch (error) {
          invalid(
            `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid knowledge artifact"})`,
          );
        }
      }
    }
    const plan = documents.plan;
    if (plan?.output.kind !== "execution_plan")
      invalid("sealed Plan is unsupported; replan before delivery");
    try {
      const satisfied = this.satisfiedAssignmentArtifacts();
      validateLinks(plan.output, documents, this.runBudget(now), new Set(satisfied.keys()));
      const selection = selectNextImplementationHandoff(
        plan.output,
        documents,
        knowledge.routing,
        satisfied,
      );
      if (selection.status === "complete")
        invalid("all planned increments are verified; the run is ready for Judgment Day");
      if (selection.status === "blocked")
        invalid(
          `the next implementation is blocked by unverified Plan dependencies (${selection.unsatisfiedDependencyIds.join(", ")})`,
        );
      const planId = knowledge.accepted.plan;
      if (!planId) invalid("sealed Plan identity is unavailable");
      const planArtifact = knowledge.artifacts[planId];
      if (!planArtifact) invalid("sealed Plan artifact is unavailable");
      const inputs = [
        ...new Set([...Object.values(knowledge.accepted), ...selection.dependencyArtifactIds]),
      ];
      return {
        ...selection.handoff,
        planArtifact,
        inputs,
        inputArtifacts: inputs.map((id) => this.artifactInput(id)),
        expectedBaseCommit: verifiedDeliveryTip(
          this.requireRun().implementations,
          this.requireRun().verifications,
        ),
      };
    } catch (error) {
      if (
        error instanceof WorkflowValidationError &&
        (error.message.startsWith("all planned increments") ||
          error.message.startsWith("the next implementation is blocked"))
      )
        throw error;
      invalid(
        `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid handoff"})`,
      );
    }
  }
  private async verificationHandoff(implementation: ImplementationState) {
    const knowledge = this.knowledge();
    if (knowledge.lifecycle.status !== "completed") invalid("the execution Plan is not sealed");
    if (implementation.lifecycle.status !== "completed")
      invalid("the increment has not produced an implementation result");
    const documents: Partial<Record<string, ReturnType<typeof parseDocument>>> = {};
    for (const [phase, id] of Object.entries(knowledge.accepted)) {
      const artifact = knowledge.artifacts[id];
      if (!artifact) invalid("accepted knowledge artifact is not registered");
      const evidence = await this.artifact(id);
      if (phase !== "discovery") {
        try {
          documents[phase] = parseDocument(evidence.content, artifact.inputs);
        } catch (error) {
          invalid(
            `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid knowledge artifact"})`,
          );
        }
      }
    }
    const plan = documents.plan;
    if (plan?.output.kind !== "execution_plan")
      invalid("sealed Plan is unsupported; replan before delivery");
    const implementationArtifactId = implementation.lifecycle.artifactId;
    const implementationArtifact = implementation.artifacts[implementationArtifactId];
    if (!implementationArtifact) invalid("implementation result evidence is unavailable");
    const evidence = await this.artifact(implementationArtifactId);
    const report = parseImplementationResult(evidence.content, implementation);
    try {
      const handoff = selectVerificationHandoff(
        plan.output,
        documents,
        knowledge.routing,
        implementation.assignment.id,
        implementation.incrementId,
      );
      const planId = knowledge.accepted.plan;
      if (!planId) invalid("sealed Plan identity is unavailable");
      const planArtifact = knowledge.artifacts[planId];
      if (!planArtifact) invalid("sealed Plan artifact is unavailable");
      const inputs = [...new Set([...implementation.assignment.inputs, implementationArtifactId])];
      const rootBaseCommit =
        this.requireRun().implementations[implementation.incrementId]?.[0]?.baseCommit ??
        implementation.baseCommit;
      return {
        ...handoff,
        planArtifact,
        inputs,
        inputArtifacts: inputs.map((id) => this.artifactInput(id)),
        implementation: {
          instanceId: implementation.instanceId,
          artifactId: implementationArtifactId,
          digest: implementationArtifact.digest,
          baseCommit: rootBaseCommit,
          evaluatedCommit: report.output.resultingCommit,
          testCommands: report.output.tests.map((test) => test.command),
        },
      };
    } catch (error) {
      invalid(
        `sealed Plan is unsupported; replan before verification (${error instanceof Error ? error.message : "invalid handoff"})`,
      );
    }
  }
  startAssignment(assignmentId?: string, fallbackModel?: string): Promise<StartedAssignment> {
    return this.serial(async () => {
      const knowledge = this.knowledge();
      if (knowledge.lifecycle.status === "completed") {
        const checkpoint = this.requireRun();
        const nowBeforeEvidence = this.now();
        const frontier = this.deliveryFrontier();

        if (frontier?.kind === "verification") {
          const { implementation, verification: verificationForLatest } = frontier;
          const verificationHistory = checkpoint.verifications[implementation.incrementId] ?? [];
          const handoff = verificationForLatest
            ? {
                assignment: verificationForLatest.assignment,
                planArtifact: knowledge.artifacts[verificationForLatest.planArtifactId],
                inputs: verificationForLatest.assignment.inputs,
                inputArtifacts: verificationForLatest.assignment.inputs.map((id) =>
                  this.artifactInput(id),
                ),
                criteria: verificationForLatest.assignment.criteria,
                verification: verificationForLatest.assignment.verification,
                implementation: verificationForLatest.implementation,
              }
            : await this.verificationHandoff(implementation);
          if (!handoff.planArtifact) invalid("verification handoff evidence is unavailable");
          for (const id of handoff.inputs) await this.artifact(id);
          const workspace = await this.inspectWorkspace(this.cwd);
          if (!workspace.clean) invalid("verification requires a clean dedicated checkout");
          if (workspace.head !== handoff.implementation.evaluatedCommit)
            invalid("verification checkout revision does not match the implementation result");
          const frozen = verificationHistory[0]?.assignment;
          const selection =
            frozen?.selection ?? knowledge.routing?.routes["verify.verifier"]?.[0] ?? null;
          const model = frozen?.model ?? (selection ? null : (fallbackModel ?? null));
          if (!selection && !model)
            invalid("verification requires the active Pi model to freeze its selection");
          const now = this.now();
          return this.commitVerification(
            transitionVerification(
              verificationForLatest ?? null,
              {
                type: "assignment.start",
                runId: knowledge.run_id,
                instanceId: verificationForLatest?.instanceId ?? this.id(),
                attemptId: this.id(),
                ...(assignmentId ? { assignmentId } : {}),
                planArtifactId: handoff.planArtifact.artifact_id,
                planDigest: handoff.planArtifact.digest,
                implementation: handoff.implementation,
                assignment: handoff.assignment,
                inputs: handoff.inputs,
                inputArtifacts: handoff.inputArtifacts,
                criteria: handoff.criteria,
                verification: handoff.verification,
                selection,
                model,
                attemptTimeMs: knowledge.policy.attemptTimeMs,
                attemptCostMicros: knowledge.policy.attemptCostMicros,
                assignmentBudget: this.assignmentBudget(
                  handoff.assignment,
                  verificationHistory,
                  now,
                ),
                globalBudget: this.runBudget(now),
              },
              now,
            ),
            now,
          );
        }

        const latestImplementation =
          frontier?.kind === "implementation" ? frontier.implementation : undefined;
        const existing =
          latestImplementation?.lifecycle.status === "active" ? latestImplementation : undefined;
        const rejected = frontier?.kind === "implementation" ? frontier.rejected : undefined;
        const rejectionArtifactId =
          rejected?.lifecycle.status === "completed" ? rejected.lifecycle.artifactId : undefined;
        const initialHandoff = !frontier
          ? await this.implementationHandoff(nowBeforeEvidence)
          : null;
        const incrementId = initialHandoff?.incrementId ?? latestImplementation?.incrementId;
        if (!incrementId) invalid("implementation increment is unavailable");
        const implementationHistory = checkpoint.implementations[incrementId] ?? [];
        const planArtifact =
          initialHandoff?.planArtifact ??
          knowledge.artifacts[
            existing?.planArtifactId ?? latestImplementation?.planArtifactId ?? ""
          ];
        if (!planArtifact) invalid("implementation handoff evidence is unavailable");
        const plannedAssignment =
          initialHandoff?.assignment ?? existing?.assignment ?? latestImplementation?.assignment;
        if (!plannedAssignment) invalid("implementation assignment is unavailable");
        const inputs = initialHandoff
          ? initialHandoff.inputs
          : existing
            ? existing.assignment.inputs
            : rejectionArtifactId && latestImplementation?.lifecycle.status === "completed"
              ? [
                  ...new Set([
                    ...latestImplementation.assignment.inputs,
                    latestImplementation.lifecycle.artifactId,
                    rejectionArtifactId,
                  ]),
                ]
              : invalid("the next delivery assignment is not eligible");
        for (const id of inputs) await this.artifact(id);
        const workspace = await this.inspectWorkspace(this.cwd);
        const lastAttemptId = existing?.assignment.attemptIds.at(-1);
        const interrupted = lastAttemptId
          ? existing?.attempts[lastAttemptId]?.outcome === "interrupted"
          : false;
        if (!existing && !workspace.clean)
          invalid(
            rejected
              ? "implementation rework requires a clean dedicated checkout"
              : "implementation requires an initially clean dedicated checkout",
          );
        if (existing && !interrupted && !workspace.clean)
          invalid("implementation retry requires a clean checkout");
        if (rejected && !existing && workspace.head !== rejected.implementation.evaluatedCommit)
          invalid("rework checkout revision does not match the rejected implementation");
        if (
          initialHandoff?.expectedBaseCommit &&
          workspace.head !== initialHandoff.expectedBaseCommit
        )
          invalid("implementation checkout revision does not match the latest verified increment");
        const frozen = implementationHistory[0]?.assignment;
        const selection =
          frozen?.selection ?? knowledge.routing?.routes["implementation.driver"]?.[0] ?? null;
        const model = frozen?.model ?? (selection ? null : (fallbackModel ?? null));
        if (!selection && !model)
          invalid("implementation requires the active Pi model to freeze its selection");
        const now = this.now();
        return this.commitImplementation(
          transitionImplementation(
            existing ?? null,
            {
              type: "assignment.start",
              runId: knowledge.run_id,
              instanceId: existing?.instanceId ?? this.id(),
              attemptId: this.id(),
              ...(assignmentId ? { assignmentId } : {}),
              planArtifactId: planArtifact.artifact_id,
              planDigest: planArtifact.digest,
              assignment: plannedAssignment,
              inputs,
              inputArtifacts: inputs.map((id) => this.artifactInput(id)),
              criteria:
                initialHandoff?.criteria ??
                existing?.assignment.criteria ??
                latestImplementation?.assignment.criteria ??
                [],
              verification:
                initialHandoff?.verification ??
                existing?.assignment.verification ??
                latestImplementation?.assignment.verification ??
                [],
              selection,
              model,
              baseCommit: existing?.baseCommit ?? workspace.head,
              attemptTimeMs: knowledge.policy.attemptTimeMs,
              attemptCostMicros: knowledge.policy.attemptCostMicros,
              assignmentBudget: this.assignmentBudget(
                plannedAssignment,
                implementationHistory,
                now,
              ),
              globalBudget: this.runBudget(now),
            },
            now,
          ),
          now,
        );
      }
      const event = {
        type: "assignment.start" as const,
        ...(assignmentId ? { assignmentId } : {}),
        newAssignmentId: this.id(),
        attemptId: this.id(),
      };
      const next = transitionKnowledge(knowledge, event, this.now());
      // Admission is tentative until local evidence checks succeed. No state has changed yet.
      for (const input of next.result.inputArtifacts ?? []) await this.artifact(input.artifact_id);
      const now = this.now();
      return this.commitKnowledge(transitionKnowledge(this.knowledge(), event, now), now);
    });
  }
  private registeredArtifact(id: string): {
    artifact_id: string;
    kind: string;
    path: string;
    version: number;
    digest: string;
  } {
    const checkpoint = this.requireRun();
    const knowledge = checkpoint.knowledge.artifacts[id];
    if (knowledge) return knowledge;
    for (const history of Object.values(checkpoint.implementations))
      for (const implementation of history) {
        const artifact = implementation.artifacts[id];
        if (artifact) return artifact;
      }
    for (const history of Object.values(checkpoint.verifications))
      for (const verification of history) {
        const artifact = verification.artifacts[id];
        if (artifact) return artifact;
      }
    invalid("input artifact is not registered");
  }
  private artifactInput(id: string) {
    const artifact = this.registeredArtifact(id);
    return {
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      path: artifact.path,
      version: artifact.version,
    };
  }
  private async artifact(id: string): Promise<Evidence> {
    const artifact = this.registeredArtifact(id);
    const evidence = await this.readArtifact(artifact.path);
    if (evidence.digest !== artifact.digest) invalid("artifact changed after registration");
    return evidence;
  }
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished> {
    return this.serial(async () => {
      const checkpoint = this.requireRun();
      const implementation = Object.values(checkpoint.implementations)
        .flat()
        .find((candidate) => Object.hasOwn(candidate.attempts, result.attemptId));
      const verification = Object.values(checkpoint.verifications)
        .flat()
        .find((candidate) => Object.hasOwn(candidate.attempts, result.attemptId));
      const now = this.now();
      if (verification) {
        let evidence: Evidence | undefined;
        if ("artifactPath" in result) {
          try {
            evidence = await this.readArtifact(result.artifactPath);
            for (const input of verification.assignment.inputs) await this.artifact(input);
          } catch (error) {
            invalid(error instanceof Error ? error.message : "invalid verification evidence");
          }
        }
        return this.commitVerification(
          transitionVerification(
            verification,
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
      }
      if (implementation) {
        let evidence: Evidence | undefined;
        if ("artifactPath" in result) {
          try {
            evidence = await this.readArtifact(result.artifactPath);
            for (const input of implementation.assignment.inputs) await this.artifact(input);
          } catch (error) {
            invalid(error instanceof Error ? error.message : "invalid implementation evidence");
          }
        }
        return this.commitImplementation(
          transitionImplementation(
            implementation,
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
      }
      const state = checkpoint.knowledge;
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
      return this.commitKnowledge(
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
      const state = this.knowledge();
      const evidence = await this.gateEvidence(state);
      const now = this.now();
      return this.commitKnowledge(
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
      const checkpoint = this.requireRun();
      if (checkpoint.knowledge.attempts[attemptId]) {
        await this.commitKnowledge(
          transitionKnowledge(
            checkpoint.knowledge,
            { type: "usage.record", attemptId, usage },
            now,
          ),
          now,
        );
        return;
      }
      const implementation = Object.values(checkpoint.implementations)
        .flat()
        .find((candidate) => Object.hasOwn(candidate.attempts, attemptId));
      const verification = Object.values(checkpoint.verifications)
        .flat()
        .find((candidate) => Object.hasOwn(candidate.attempts, attemptId));
      const delivery = implementation ?? verification;
      if (!delivery) invalid("attempt is not registered");
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
      await this.persist(
        [{ type: "model.usage", data }],
        undefined,
        now,
        implementation ? implementationDefinition : verificationDefinition,
        {
          runId: delivery.runId,
          instanceId: delivery.instanceId,
        },
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
        run: this.state ? toRunSummary(this.state.knowledge) : null,
        ...(this.state ? { workflow: workflowPosition(this.state.knowledge) } : {}),
        ...(this.state && Object.keys(this.state.implementations).length
          ? {
              implementations: Object.fromEntries(
                Object.entries(this.state.implementations).map(([incrementId, history]) => {
                  const implementation = history.at(-1);
                  if (!implementation) invalid("implementation history is empty");
                  return [incrementId, implementationPosition(implementation)];
                }),
              ),
            }
          : {}),
        ...(this.state && Object.keys(this.state.verifications).length
          ? {
              verifications: Object.fromEntries(
                Object.entries(this.state.verifications).map(([incrementId, history]) => {
                  const verification = history.at(-1);
                  if (!verification) invalid("verification history is empty");
                  return [incrementId, verificationPosition(verification)];
                }),
              ),
            }
          : {}),
        timeline: structuredClone(this.timeline),
        durability: this.journal.durability,
        ...(this.journal.problem ? { degradedReason: this.journal.problem } : {}),
      };
    });
  }
}
