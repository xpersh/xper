import {
  approvalContext,
  checkResolutionReplay,
  readAppliedResolution,
} from "./runtime/resolution.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  RecordedEvent,
  RecorderClient,
  ResolvedConfiguration,
} from "../bridge/xper-client.js";
import { inspectGitWorkspace, type GitWorkspace } from "../execution/workspace.js";
import { saveArtifact } from "../execution/artifacts.js";
import { assertRunOpen, judgmentReplay } from "./delivery/closure.js";
import { prepareClosure } from "./runtime/closure.js";
import { decodeAdapterCheckpoint } from "./checkpoint/decode.js";
import { recoveryChanges } from "./checkpoint/recovery.js";
import type { AdapterCheckpoint } from "./checkpoint/types.js";
import { knowledgeChange, type CheckpointChange } from "./checkpoint/update.js";
import {
  feedbackReplay,
  knowledgeFeedbackChange,
  reconciliationAwaitingChange,
  requireFeedbackReport,
} from "./delivery/reconcile.js";
import { verificationFeedback } from "./delivery/reconciliation.js";
import { resumeChange, validateResumeRequest, validateResumeRevision } from "./delivery/resume.js";
import { usageChange } from "./delivery/usage.js";
import { readEvidence } from "./evidence.js";
import { WorkflowJournal } from "./journal.js";
import type { Evidence, Transition } from "./knowledge/events.js";
import { transitionKnowledge } from "./knowledge/machine.js";
import type { WorkflowState } from "./knowledge/state.js";
import { prepareAssignment } from "./runtime/assignment.js";
import { prepareRecordedEvents } from "./runtime/events.js";
import { prepareGateEvidence, readRegisteredArtifact } from "./runtime/evidence.js";
import type { ArtifactWriter, WorkflowEffects } from "./runtime/ports.js";
import { prepareSettlement } from "./runtime/settlement.js";
import { projectRunStatus } from "./status.js";
import type {
  AttemptFinished,
  DeliveryResumed,
  FinishAttempt,
  ModelUsage,
  JudgmentApplied,
  JudgmentApproval,
  JudgmentResolutionInput,
  RoutingSnapshot,
  RunAdvanced,
  RunStarted,
  RunStatus,
  StartedAssignment,
  WorkflowClient,
  WorkflowPolicy,
} from "./types.js";
import { WorkflowValidationError } from "./types.js";
import { invalid } from "./validation.js";
import { parseVerificationResult } from "./verification/result.js";
import type { VerificationState } from "./verification/state.js";
export type { WorkflowState } from "./knowledge/state.js";

interface Options {
  writeArtifact?: ArtifactWriter;
  configuration?: () => ResolvedConfiguration | null;
  now?: () => number;
  id?: () => string;
  readArtifact?: (path: string) => Promise<Evidence>;
  inspectWorkspace?: (cwd: string) => Promise<GitWorkspace>;
}

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
  private readonly writeArtifact: ArtifactWriter;
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
    this.writeArtifact =
      options.writeArtifact ?? ((id, content, path) => saveArtifact(cwd, id, content, path));
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

  private commitKnowledge<Result>(transition: Transition<Result>, now: number): Promise<Result> {
    return this.commit(knowledgeChange(this.state, transition), now);
  }
  private async commit<Result>(change: CheckpointChange<Result>, now: number): Promise<Result> {
    this.state = change.state;
    if (!change.facts.length) return structuredClone(change.result);
    const events = prepareRecordedEvents(
      change.state,
      change.facts,
      now,
      change.definition,
      change.context,
      this.definitionsRecorded,
      this.id,
    );
    this.timeline.push(...events);
    await this.journal.commit(change.state, events);
    return structuredClone(change.result);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.journal.load();
    this.state = decodeAdapterCheckpoint(this.journal.state);
    this.timeline = [...this.journal.pending];
    this.loaded = true;
    if (this.state) {
      const now = this.now();
      for (const change of recoveryChanges(this.state, now)) await this.commit(change, now);
      await this.recoverKnowledgeFeedback(now);
      await this.markReconciliationAwaiting(now);
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

  private async applyKnowledgeFeedback(
    verification: VerificationState,
    now: number,
  ): Promise<RunAdvanced | null> {
    const checkpoint = this.requireRun();
    const feedback = verificationFeedback(verification);
    if (!feedback) return null;
    const replay = feedbackReplay(checkpoint, verification);
    if (replay) return replay;
    const evidence = await this.artifact(feedback.artifact.artifact_id);
    const report = parseVerificationResult(evidence.content, verification);
    // Preserve validation before allocating the next visit identity.
    requireFeedbackReport(verification, report);
    return this.commit(
      knowledgeFeedbackChange(checkpoint, verification, report, this.id(), now),
      now,
    );
  }
  private async recoverKnowledgeFeedback(now: number): Promise<void> {
    const checkpoint = this.requireRun();
    for (const history of Object.values(checkpoint.verifications)) {
      for (const verification of history) {
        const feedback = verificationFeedback(verification);
        if (!feedback || checkpoint.knowledge.imports[feedback.artifact.artifact_id]) continue;
        await this.applyKnowledgeFeedback(verification, now);
      }
    }
  }

  private async markReconciliationAwaiting(now: number): Promise<boolean> {
    const change = reconciliationAwaitingChange(this.requireRun());
    return change ? this.commit(change, now) : false;
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
      assertRunOpen(this.state);
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

  startAssignment(assignmentId?: string, fallbackModel?: string): Promise<StartedAssignment> {
    return this.serial(async () => {
      assertRunOpen(this.requireRun());
      const prepared = await prepareAssignment(
        this.requireRun(),
        assignmentId,
        fallbackModel,
        this.effects(),
      );
      return this.commit(prepared.change, prepared.now);
    });
  }
  private effects(): WorkflowEffects {
    return {
      cwd: this.cwd,
      now: this.now,
      id: this.id,
      readArtifact: this.readArtifact,
      inspectWorkspace: this.inspectWorkspace,
    };
  }

  private artifact(id: string): Promise<Evidence> {
    return readRegisteredArtifact(this.requireRun(), this.readArtifact, id);
  }
  finishAttempt(result: FinishAttempt): Promise<AttemptFinished> {
    return this.serial(async () => {
      const prepared = await prepareSettlement(this.requireRun(), result, this.effects());
      const settled = await this.commit(prepared.change, prepared.now);
      if (!prepared.feedbackSource) return settled;
      // The Verification result must be committed before importing its feedback.
      const handoff = await this.applyKnowledgeFeedback(prepared.feedbackSource, prepared.now);
      const handoffPhase =
        handoff?.phase === "define" || handoff?.phase === "design" ? handoff.phase : undefined;
      return handoffPhase && settled.outcome === "succeeded"
        ? { ...settled, handoffPhase }
        : settled;
    });
  }

  advanceRun(approvedArtifactId?: string): Promise<RunAdvanced> {
    return this.serial(async () => {
      assertRunOpen(this.requireRun());
      if (approvedArtifactId && approvedArtifactId === this.state?.judgment?.report?.artifact_id)
        invalid("apply the Judge report with /xper approve <reportId> <commit>");
      const state = this.knowledge();
      const evidence = await prepareGateEvidence(this.requireRun(), this.readArtifact);
      const now = this.now();
      const result = await this.commitKnowledge(
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
      const resumeRequired = await this.markReconciliationAwaiting(now);
      return resumeRequired ? { ...result, resumeRequired: true } : result;
    });
  }
  resumeDelivery(revision: string): Promise<DeliveryResumed> {
    return this.serial(async () => {
      assertRunOpen(this.requireRun());
      validateResumeRevision(revision);
      const checkpoint = this.requireRun();
      const replay = validateResumeRequest(checkpoint, revision);
      if (replay) return replay;
      const workspace = await this.inspectWorkspace(this.cwd);
      const change = resumeChange(checkpoint, revision, workspace);
      return this.commit(change, this.now());
    });
  }
  recordUsage(attemptId: string, usage: ModelUsage): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      await this.commit(usageChange(this.requireRun(), attemptId, usage, now), now);
    });
  }
  prepareJudgmentApproval(reportId: string, revision: string): Promise<JudgmentApproval> {
    return this.serial(async () => {
      const checkpoint = this.requireRun();
      const replay = judgmentReplay(checkpoint, reportId, revision);
      if (replay) {
        await checkResolutionReplay(checkpoint, replay, undefined, this.effects());
        return { applied: replay };
      }
      return structuredClone((await approvalContext(checkpoint, reportId, this.effects())).context);
    });
  }
  applyJudgment(
    reportId: string,
    revision: string,
    resolution?: JudgmentResolutionInput,
  ): Promise<JudgmentApplied> {
    return this.serial(async () => {
      const checkpoint = this.requireRun();
      const replay = judgmentReplay(checkpoint, reportId, revision);
      if (replay) {
        await checkResolutionReplay(checkpoint, replay, resolution, this.effects());
        return replay;
      }
      const prepared = await prepareClosure(
        checkpoint,
        reportId,
        revision,
        {
          ...this.effects(),
          writeArtifact: this.writeArtifact,
        },
        resolution,
      );
      return this.commit(prepared.change, prepared.now);
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
      const status = projectRunStatus(
        this.state,
        this.timeline,
        {
          durability: this.journal.durability,
          problem: this.journal.problem,
        },
        this.now(),
      );
      const decision = status.closure ?? status.feedback;
      if (decision?.resolution)
        status.humanResolution = await readAppliedResolution(
          this.requireRun(),
          decision,
          this.effects(),
        );
      return status;
    });
  }
}
