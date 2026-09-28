import type { ResolvedConfiguration } from "../bridge/xper-client.js";
import { parseDocument, validateLinks, type Document } from "./contracts.js";
import {
  knowledgeDefinition,
  forwardTransition,
  feedbackTransition,
  phasesInvalidatedBy,
} from "./definition.js";
import { admit, budgetRemaining, contracts, policyFrom } from "./policy.js";
import { currentVisit, type Assignment, type WorkflowState } from "./state.js";
import { WorkflowValidationError } from "./types.js";
import type {
  AssignmentStarted,
  AttemptFinished,
  FinishAttempt,
  ModelUsage,
  RunAdvanced,
  RunStarted,
  WorkflowPolicy,
  WorkflowPosition,
} from "./types.js";

export interface WorkflowFact {
  type: string;
  data: Record<string, unknown>;
}
export interface Evidence {
  content: string;
  digest: string;
}
export type GateEvidence = { artifacts: Record<string, Evidence> } | { error: string };

export type KnowledgeEvent =
  | {
      type: "run.start";
      runId: string;
      instanceId: string;
      visitId: string;
      objectiveHash: string;
      configuration: ResolvedConfiguration;
      policy?: WorkflowPolicy;
    }
  | { type: "assignment.start"; assignmentId?: string; newAssignmentId: string; attemptId: string }
  | { type: "attempt.finish"; result: FinishAttempt; artifactId: string; evidence?: Evidence }
  | {
      type: "gate.evaluate";
      approvedArtifactId?: string;
      nextVisitId: string;
      evidence: GateEvidence;
    }
  | { type: "session.recover" }
  | { type: "usage.record"; attemptId: string; usage: ModelUsage };

interface Results {
  "run.start": RunStarted;
  "assignment.start": AssignmentStarted;
  "attempt.finish": AttemptFinished;
  "gate.evaluate": RunAdvanced;
  "session.recover": undefined;
  "usage.record": undefined;
}
export interface Transition<Result> {
  state: WorkflowState;
  facts: WorkflowFact[];
  result: Result;
}

function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}
export function remainingBudget(state: WorkflowState, now: number) {
  return budgetRemaining(state.policy, state.startedAt, now, Object.keys(state.attempts).length);
}
function attemptOutcome(state: WorkflowState, result: FinishAttempt, now: number) {
  const attempt = state.attempts[result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  return result.outcome === "succeeded" &&
    (now - attempt.startedAt >= attempt.timeoutMs || !remainingBudget(state, now).timeMs)
    ? "timed_out"
    : result.outcome;
}
/** Runtime uses this same decision to avoid evidence I/O for replay and late results. */
export function completionNeedsEvidence(
  state: WorkflowState,
  result: FinishAttempt,
  now: number,
): boolean {
  const attempt = state.attempts[result.attemptId];
  if (!attempt) invalid("attempt is not registered");
  if (result.outcome === "succeeded" && result.artifactPath !== attempt.artifactPath)
    invalid("artifact path does not match the assignment");
  return attempt.outcome === null && attemptOutcome(state, result, now) === "succeeded";
}
export function gateArtifact(state: WorkflowState) {
  const visit = currentVisit(state);
  return Object.values(state.artifacts)
    .reverse()
    .find((artifact) => {
      const attempt = state.attempts[artifact.attemptId];
      return (
        attempt?.outcome === "succeeded" &&
        state.assignments[attempt.assignmentId]?.visitId === visit.id
      );
    });
}
export function workflowPosition(state: WorkflowState): WorkflowPosition {
  const visit = currentVisit(state);
  return {
    definitionId: state.definition.id,
    definitionVersion: state.definition.version,
    instanceId: state.instanceId,
    nodeId: state.lifecycle.status === "completed" ? "ready" : visit.phase,
    phase: visit.phase,
    visitId: visit.id,
    status: state.lifecycle.status,
    activeAttemptIds: Object.entries(state.attempts)
      .filter(([, attempt]) => attempt.outcome === null)
      .map(([id]) => id),
    ...(state.lifecycle.status === "awaiting_approval"
      ? { artifactId: state.lifecycle.artifactId }
      : {}),
  };
}

/** Deterministic domain transition. IDs, time and evidence are supplied by the runtime. */
export function transitionKnowledge<E extends KnowledgeEvent>(
  previous: WorkflowState | null,
  event: E,
  now: number,
): Transition<Results[E["type"]]> {
  const facts: WorkflowFact[] = [];
  const fact = (type: string, data: Record<string, unknown>) => facts.push({ type, data });
  let state = previous ? structuredClone(previous) : null;
  if (
    state &&
    (state.definition.id !== knowledgeDefinition.id ||
      state.definition.version !== knowledgeDefinition.version)
  )
    invalid("unsupported workflow definition");
  const finish = (result: Results[KnowledgeEvent["type"]]): Transition<Results[E["type"]]> => {
    if (!state) invalid("start a workflow first");
    if (facts.length) {
      state.revision++;
      fact("workflow.position", { ...workflowPosition(state) });
    }
    return { state, facts, result: structuredClone(result) as Results[E["type"]] };
  };
  if (event.type === "run.start") {
    if (state)
      return finish({ runId: state.run_id, phase: currentVisit(state).phase, resumed: true });
    const { routing, adapterConfig } = event.configuration;
    const policy = policyFrom(structuredClone(event.policy ?? (adapterConfig as WorkflowPolicy)));
    if (routing && !routing.routes[contracts.discovery.role]?.length)
      invalid("active profile has no Discovery route");
    const initial = knowledgeDefinition.initial;
    if (initial === "ready") invalid("knowledge initial state must be an activity");
    state = {
      version: 2,
      revision: 0,
      run_id: event.runId,
      instanceId: event.instanceId,
      definition: { id: knowledgeDefinition.id, version: knowledgeDefinition.version },
      startedAt: now,
      routing: structuredClone(routing),
      policy,
      visits: [{ id: event.visitId, phase: initial }],
      assignments: {},
      attempts: {},
      artifacts: {},
      accepted: {},
      feedback: null,
      lifecycle: { status: "active" },
    };
    fact("run.started", {
      workflow: `${state.definition.id}.v${state.definition.version}`,
      objectiveHash: event.objectiveHash,
      profile: routing?.profile ?? null,
      context: routing?.context ?? null,
    });
    fact("phase.entered", { phase: "discovery", visitId: event.visitId });
    return finish({ runId: state.run_id, phase: "discovery", resumed: false });
  }
  if (!state) invalid("start a workflow first");
  const visit = currentVisit(state),
    phase = visit.phase;
  switch (event.type) {
    case "assignment.start": {
      if (state.lifecycle.status === "completed")
        invalid("implementation is not available; the execution plan is ready");
      const budget = remainingBudget(state, now);
      admit(
        state.policy,
        budget,
        Object.values(state.attempts).filter((attempt) => attempt.outcome === null).length,
      );
      let assignment: Assignment | undefined;
      if (event.assignmentId) {
        assignment = state.assignments[event.assignmentId];
        if (
          !assignment ||
          assignment.visitId !== visit.id ||
          state.attempts[assignment.attemptIds.at(-1) ?? ""]?.outcome !== "interrupted"
        )
          invalid("only an interrupted assignment from the current visit can be retried");
      } else {
        const role = contracts[phase].role;
        const selection = state.routing?.routes[role]?.[0] ?? null;
        if (state.routing && !selection) invalid(`active profile has no route for ${role}`);
        if (state.assignments[event.newAssignmentId]) invalid("assignment ID already exists");
        assignment = {
          id: event.newAssignmentId,
          visitId: visit.id,
          phase,
          role,
          inputs: [
            ...new Set([
              ...Object.values(state.accepted),
              ...(state.feedback ? [state.feedback] : []),
            ]),
          ].sort(),
          selection,
          attemptIds: [] as string[],
        };
        state.assignments[assignment.id] = assignment;
        fact("assignment.created", {
          assignmentId: assignment.id,
          visitId: visit.id,
          role,
          inputs: assignment.inputs,
        });
      }
      if (state.attempts[event.attemptId]) invalid("attempt ID already exists");
      if (state.lifecycle.status === "awaiting_approval") {
        fact("human.wait.finished", {
          visitId: state.lifecycle.visitId,
          artifactId: state.lifecycle.artifactId,
          reason: "superseded",
        });
        state.lifecycle = { status: "active" };
      }
      const artifactPath =
        phase === "discovery"
          ? `.xper/artifacts/discovery-brief-${event.attemptId}.md`
          : `.xper/artifacts/${contracts[phase].kind.replaceAll("_", "-")}-${event.attemptId}.json`;
      const timeoutMs = Math.min(state.policy.attemptTimeMs, budget.timeMs);
      state.attempts[event.attemptId] = {
        assignmentId: assignment.id,
        startedAt: now,
        timeoutMs,
        outcome: null,
        artifactId: null,
        artifactPath,
        selection: assignment.selection,
      };
      assignment.attemptIds.push(event.attemptId);
      fact("attempt.started", {
        attemptId: event.attemptId,
        assignmentId: assignment.id,
        visitId: visit.id,
        role: assignment.role,
        selection: assignment.selection,
        timeoutMs,
      });
      if (assignment.selection)
        fact("model.resolved", { attemptId: event.attemptId, ...assignment.selection });
      return finish({
        runId: state.run_id,
        assignmentId: assignment.id,
        attemptId: event.attemptId,
        role: assignment.role,
        selection: assignment.selection,
        phase,
        artifactKind: contracts[phase].kind,
        artifactPath,
        inputArtifacts: assignment.inputs.map((id) => {
          const artifact = state?.artifacts[id];
          if (!artifact) invalid("input artifact unavailable");
          return {
            artifact_id: artifact.artifact_id,
            kind: artifact.kind,
            path: artifact.path,
            version: artifact.version,
          };
        }),
        timeoutMs,
        budget: remainingBudget(state, now),
      });
    }
    case "attempt.finish": {
      const { result } = event,
        attempt = state.attempts[result.attemptId];
      if (!attempt) invalid("attempt is not registered");
      if (attempt.outcome !== null) {
        if (
          attempt.outcome !== result.outcome &&
          !(result.outcome === "succeeded" && attempt.outcome === "timed_out")
        )
          invalid("attempt already has a different outcome");
        if (result.outcome === "succeeded" && result.artifactPath !== attempt.artifactPath)
          invalid("artifact path does not match the assignment");
        return finish({
          attemptId: result.attemptId,
          outcome: attempt.outcome as FinishAttempt["outcome"],
          replayed: true,
        });
      }
      const outcome = attemptOutcome(state, result, now);
      const assignment = state.assignments[attempt.assignmentId];
      if (!assignment) invalid("assignment is not registered");
      if (outcome === "succeeded" && result.outcome === "succeeded") {
        if (result.artifactPath !== attempt.artifactPath)
          invalid("artifact path does not match the assignment");
        const evidence = event.evidence;
        if (!evidence) invalid("artifact evidence is required");
        if (!evidence.content.trim() || !evidence.digest.trim())
          invalid("artifact evidence is empty");
        let document: Document | null;
        try {
          document =
            assignment.phase === "discovery"
              ? null
              : parseDocument(evidence.content, assignment.inputs);
        } catch (error) {
          invalid(error instanceof Error ? error.message : "invalid artifact");
        }
        const kind = document?.output.kind ?? "discovery_brief";
        if (kind !== contracts[assignment.phase].kind && kind !== "feedback")
          invalid("artifact kind does not match the current phase");
        if (state.artifacts[event.artifactId]) invalid("artifact ID already exists");
        state.artifacts[event.artifactId] = {
          artifact_id: event.artifactId,
          attemptId: result.attemptId,
          kind,
          path: result.artifactPath,
          version: 1,
          digest: evidence.digest,
          inputs: [...assignment.inputs],
        };
        attempt.artifactId = event.artifactId;
        fact("artifact.registered", {
          artifactId: event.artifactId,
          attemptId: result.attemptId,
          kind,
          path: result.artifactPath,
          digest: evidence.digest,
          inputs: assignment.inputs,
        });
      }
      attempt.outcome = outcome;
      fact("attempt.finished", {
        attemptId: result.attemptId,
        assignmentId: attempt.assignmentId,
        outcome,
        durationMs: Math.max(0, now - attempt.startedAt),
      });
      return finish({ attemptId: result.attemptId, outcome, artifactId: attempt.artifactId });
    }
    case "gate.evaluate": {
      const blocked = (reason: string): Transition<Results[E["type"]]> => {
        fact("gate.failed", { phase, visitId: visit.id, reason });
        return finish({ advanced: false, phase, reason });
      };
      const budget = remainingBudget(state, now);
      if (!budget.timeMs) return blocked("run time budget exhausted");
      if (Object.values(state.attempts).some((attempt) => attempt.outcome === null))
        return blocked("an attempt is still running");
      const artifact = gateArtifact(state);
      if (!artifact) return blocked("a successful phase artifact is required");
      const approval = state.lifecycle.status === "awaiting_approval" ? state.lifecycle : null;
      if (
        event.approvedArtifactId &&
        (!approval ||
          approval.visitId !== visit.id ||
          approval.artifactId !== event.approvedArtifactId ||
          event.approvedArtifactId !== artifact.artifact_id)
      )
        invalid("approval does not match the pending visit and artifact");
      if ("error" in event.evidence) return blocked(event.evidence.error);
      const evidence = event.evidence.artifacts;
      const content = (id: string): string => {
        const registered = state?.artifacts[id],
          observed = evidence[id];
        if (!registered || !observed) throw new Error("artifact unavailable");
        if (registered.digest !== observed.digest)
          throw new Error("artifact changed after registration");
        return observed.content;
      };
      let document: Document | undefined;
      try {
        const output = content(artifact.artifact_id);
        for (const id of artifact.inputs) content(id);
        if (phase !== "discovery") document = parseDocument(output, artifact.inputs);
        if (document?.output.kind !== "feedback") {
          if (document?.output.kind === "design_decisions" && !document.output.feasible)
            return blocked("design is not feasible; provide evidence-backed feedback");
          const upstream: Partial<Record<string, Document>> = {};
          for (const [inputPhase, id] of Object.entries(state.accepted)) {
            const input = content(id);
            if (inputPhase !== "discovery")
              upstream[inputPhase] = parseDocument(input, state.artifacts[id]?.inputs ?? []);
          }
          if (document) validateLinks(document.output, upstream, budget);
        }
      } catch (error) {
        return blocked(error instanceof Error ? error.message : "artifact unavailable");
      }
      if (document?.output.kind === "feedback") {
        const edge = feedbackTransition(phase, document.output.reason);
        if (!edge || edge.to === "ready")
          return blocked("feedback must identify an earlier responsible phase");
        if (state.visits.some((visit) => visit.id === event.nextVisitId))
          invalid("visit ID already exists");
        for (const invalidated of phasesInvalidatedBy(edge.to)) delete state.accepted[invalidated];
        state.feedback = artifact.artifact_id;
        state.lifecycle = { status: "active" };
        state.visits.push({ id: event.nextVisitId, phase: edge.to });
        fact("phase.exited", { phase, visitId: visit.id });
        fact("phase.revisited", {
          phase: edge.to,
          from: phase,
          reason: document.output.reason,
          artifactId: artifact.artifact_id,
        });
        fact("phase.entered", { phase: edge.to, visitId: event.nextVisitId });
        fact("workflow.transition", {
          transitionId: edge.id,
          from: edge.from,
          to: edge.to,
          fromVisitId: visit.id,
          toVisitId: event.nextVisitId,
        });
        return finish({ advanced: true, phase: edge.to });
      }
      if (state.lifecycle.status === "completed")
        return finish({ advanced: true, phase, ready: true, resumed: true });
      if (state.policy.humanGates.includes(phase)) {
        if (!event.approvedArtifactId) {
          if (!approval) {
            state.lifecycle = {
              status: "awaiting_approval",
              visitId: visit.id,
              artifactId: artifact.artifact_id,
            };
            fact("human.wait.started", {
              phase,
              visitId: visit.id,
              artifactId: artifact.artifact_id,
            });
          }
          return finish({
            advanced: false,
            phase,
            reason: "human approval required",
            humanArtifactId: artifact.artifact_id,
          });
        }
        fact("human.approved", { phase, visitId: visit.id, artifactId: event.approvedArtifactId });
        fact("human.wait.finished", { visitId: visit.id, artifactId: event.approvedArtifactId });
      }
      const edge = forwardTransition(phase);
      if (!edge) invalid("knowledge transition is not defined");
      if (edge.to !== "ready" && state.visits.some((visit) => visit.id === event.nextVisitId))
        invalid("visit ID already exists");
      state.accepted[phase] = artifact.artifact_id;
      state.feedback = null;
      fact("gate.passed", { phase, visitId: visit.id, artifactId: artifact.artifact_id });
      if (edge.to === "ready") {
        state.lifecycle = { status: "completed", artifactId: artifact.artifact_id };
        fact("run.status", { status: "ready" });
        fact("workflow.completed", { artifactId: artifact.artifact_id, outputKind: artifact.kind });
      } else {
        state.lifecycle = { status: "active" };
        state.visits.push({ id: event.nextVisitId, phase: edge.to });
        fact("phase.exited", { phase, visitId: visit.id });
        fact("phase.entered", { phase: edge.to, visitId: event.nextVisitId });
      }
      fact("workflow.transition", {
        transitionId: edge.id,
        from: edge.from,
        to: edge.to,
        fromVisitId: visit.id,
        toVisitId: edge.to === "ready" ? visit.id : event.nextVisitId,
      });
      return finish({
        advanced: true,
        phase: edge.to === "ready" ? phase : edge.to,
        ...(edge.to === "ready" ? { ready: true } : {}),
      });
    }
    case "session.recover": {
      for (const [attemptId, attempt] of Object.entries(state.attempts)) {
        if (attempt.outcome !== null) continue;
        attempt.outcome = "interrupted";
        fact("attempt.finished", {
          attemptId,
          outcome: "interrupted",
          assignmentId: attempt.assignmentId,
        });
      }
      return finish(undefined);
    }
    case "usage.record": {
      if (!state.attempts[event.attemptId]) invalid("attempt is not registered");
      const data: Record<string, unknown> = { attemptId: event.attemptId };
      for (const key of [
        "inputTokens",
        "outputTokens",
        "costMicros",
        "cacheReadTokens",
        "cacheWriteTokens",
      ] as const) {
        const value = event.usage[key];
        if (value === null || (Number.isSafeInteger(value) && Number(value) >= 0))
          data[key] = value;
      }
      if (event.usage.provider) data.provider = event.usage.provider;
      if (event.usage.model) data.model = event.usage.model;
      if (event.usage.costSource) data.costSource = event.usage.costSource;
      fact("model.usage", data);
      return finish(undefined);
    }
  }
}
