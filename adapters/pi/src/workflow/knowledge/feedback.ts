import { invalid } from "../validation.js";
import { feedbackTransition, phasesInvalidatedBy } from "./definition.js";
import type { FactEmitter, KnowledgeEvent, Results } from "./events.js";
import { currentVisit, type WorkflowState } from "./state.js";

export function receiveDeliveryFeedback(
  state: WorkflowState,
  event: Extract<KnowledgeEvent, { type: "delivery.feedback" }>,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["delivery.feedback"] } {
  const visit = currentVisit(state);
  const phase = visit.phase;
  const target = event.reason === "ambiguous_criteria" ? "define" : "design";
  if (state.imports[event.artifact.artifact_id])
    return { state, result: { advanced: true, phase: currentVisit(state).phase, resumed: true } };
  if (state.lifecycle.status !== "completed")
    invalid("finish the current Knowledge revisit before accepting another feedback request");
  const planId = state.accepted.plan;
  const plan = planId ? state.artifacts[planId] : undefined;
  if (
    !plan ||
    planId !== event.planArtifactId ||
    plan.digest !== event.planDigest ||
    state.lifecycle.artifactId !== planId
  )
    invalid("knowledge feedback does not match the sealed Plan revision");
  if (
    !event.sourceAttemptId.trim() ||
    !(event.incrementId?.trim() || event.incrementIds?.length) ||
    !event.evidence.trim() ||
    !event.artifact.digest.trim() ||
    !["verification_result", "judgment_verdict"].includes(event.artifact.kind) ||
    event.artifact.version !== 1
  )
    invalid("knowledge feedback request is incomplete");
  if (
    state.artifacts[event.artifact.artifact_id] ||
    state.visits.some((candidate) => candidate.id === event.nextVisitId)
  )
    invalid("knowledge feedback identity already exists");
  const edge = feedbackTransition("ready", event.reason);
  if (!edge || edge.to !== target) invalid("knowledge feedback target is not defined");
  state.imports[event.artifact.artifact_id] = structuredClone(event.artifact);
  if (event.resolution) {
    if (
      event.artifact.kind !== "judgment_verdict" ||
      event.resolution.kind !== "judgment_resolution" ||
      event.resolution.artifact_id !== `judgment-resolution-${event.artifact.artifact_id}` ||
      event.resolution.version !== 1 ||
      !event.resolution.digest
    )
      invalid("invalid human resolution feedback");
    state.imports[event.resolution.artifact_id] = structuredClone(event.resolution);
  }
  for (const invalidated of phasesInvalidatedBy(target)) {
    const artifactId = state.accepted[invalidated];
    if (!artifactId) continue;
    delete state.accepted[invalidated];
    fact("artifact.invalidated", {
      artifactId,
      reasonArtifactId: event.artifact.artifact_id,
      sourceAttemptId: event.sourceAttemptId,
    });
  }
  state.feedback = event.artifact.artifact_id;
  state.lifecycle = { status: "active" };
  state.visits.push({ id: event.nextVisitId, phase: target });
  fact("phase.exited", { phase, visitId: visit.id });
  fact("phase.revisited", {
    phase: target,
    from: "ready",
    reason: event.reason,
    evidence: event.evidence,
    paths: event.paths,
    artifactId: event.artifact.artifact_id,
    sourceAttemptId: event.sourceAttemptId,
    ...(event.incrementId
      ? { incrementId: event.incrementId }
      : { incrementIds: event.incrementIds }),
    planArtifactId: event.planArtifactId,
    planDigest: event.planDigest,
  });
  fact("phase.entered", { phase: target, visitId: event.nextVisitId });
  fact("workflow.transition", {
    transitionId: edge.id,
    from: edge.from,
    to: edge.to,
    fromVisitId: visit.id,
    toVisitId: event.nextVisitId,
  });
  return { state, result: { advanced: true, phase: target } };
}
