import { admit, contracts } from "../policy.js";
import { invalid } from "../validation.js";
import type { FactEmitter, KnowledgeEvent, Results } from "./events.js";
import { remainingBudget } from "./selectors.js";
import { currentVisit, type Assignment, type WorkflowState } from "./state.js";

export function startAssignment(
  state: WorkflowState,
  event: Extract<KnowledgeEvent, { type: "assignment.start" }>,
  now: number,
  fact: FactEmitter,
): { state: WorkflowState; result: Results["assignment.start"] } {
  const visit = currentVisit(state);
  const phase = visit.phase;
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
        ...new Set([...Object.values(state.accepted), ...(state.feedback ? [state.feedback] : [])]),
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
  return {
    state,
    result: {
      runId: state.run_id,
      assignmentId: assignment.id,
      attemptId: event.attemptId,
      role: assignment.role,
      selection: assignment.selection,
      phase,
      artifactKind: contracts[phase].kind,
      artifactPath,
      inputArtifacts: assignment.inputs.map((id) => {
        const artifact = state?.artifacts[id] ?? state?.imports[id];
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
    },
  };
}
