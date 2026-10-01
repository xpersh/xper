import { selectImplementationHandoff, validateLinks } from "../delivery/plan.js";
import { invalid } from "../validation.js";
import type { Document } from "./contract.js";
import { parseDocument } from "./contracts.js";
import { feedbackTransition, forwardTransition, phasesInvalidatedBy } from "./definition.js";
import type { FactEmitter, KnowledgeEvent, Results } from "./events.js";
import { gateArtifact, remainingBudget } from "./selectors.js";
import { currentVisit, type WorkflowState } from "./state.js";

export function evaluateGate(
  state: WorkflowState,
  event: Extract<KnowledgeEvent, { type: "gate.evaluate" }>,
  now: number,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["gate.evaluate"] } {
  const visit = currentVisit(state);
  const phase = visit.phase;
  const blocked = (reason: string): { state: WorkflowState; result: Results["gate.evaluate"] } => {
    fact("gate.failed", { phase, visitId: visit.id, reason });
    return { state, result: { advanced: false, phase, reason } };
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
    const registered = state?.artifacts[id] ?? state?.imports[id],
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
      if (document) {
        validateLinks(document.output, upstream, budget);
        if (document.output.kind === "execution_plan")
          selectImplementationHandoff(document.output, upstream, state.routing);
      }
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
    return { state, result: { advanced: true, phase: edge.to } };
  }
  if (state.lifecycle.status === "completed")
    return { state, result: { advanced: true, phase, ready: true, resumed: true } };
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
      return {
        state,
        result: {
          advanced: false,
          phase,
          reason: "human approval required",
          humanArtifactId: artifact.artifact_id,
        },
      };
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
  return {
    state,
    result: {
      advanced: true,
      phase: edge.to === "ready" ? phase : edge.to,
      ...(edge.to === "ready" ? { ready: true } : {}),
    },
  };
}
