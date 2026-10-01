import { findTransition } from "../graph.js";
import { admit, type Policy } from "../policy.js";
import type {
  AttemptFinished,
  FinishAttempt,
  JudgmentAssignmentStarted,
  RemainingBudget,
} from "../types.js";
import { invalid } from "../validation.js";
import { parseJudgmentReport } from "./contract.js";
import { judgmentDefinition } from "./definition.js";
import { judgmentPosition, type JudgmentState } from "./state.js";

type Seed = Pick<
  JudgmentState,
  "runId" | "instanceId" | "assignmentId" | "evaluation" | "selection" | "model"
>;
type Event =
  | {
      type: "assignment.start";
      seed: Seed;
      attemptId: string;
      assignmentId?: string;
      budget: RemainingBudget;
      policy: Policy;
    }
  | {
      type: "attempt.finish";
      result: FinishAttempt;
      artifactId: string;
      evidence?: { content: string; digest: string };
    }
  | { type: "session.recover" };
type Results = {
  "assignment.start": JudgmentAssignmentStarted;
  "attempt.finish": AttemptFinished;
  "session.recover": undefined;
};
export interface JudgmentTransition<R> {
  state: JudgmentState;
  facts: Array<{ type: string; data: Record<string, unknown> }>;
  result: R;
}
export function transitionJudgment<E extends Event>(
  previous: JudgmentState | null,
  event: E,
  now: number,
): JudgmentTransition<Results[E["type"]]> {
  const state = previous
    ? structuredClone(previous)
    : event.type === "assignment.start"
      ? ({
          ...structuredClone(event.seed),
          version: 1 as const,
          revision: 0,
          definition: { id: judgmentDefinition.id, version: judgmentDefinition.version },
          attempts: {},
          report: null,
        } as JudgmentState)
      : invalid("start Judgment first");
  const facts: JudgmentTransition<unknown>["facts"] = [];
  const fact = (type: string, data: Record<string, unknown>) => {
    facts.push({ type, data });
  };
  let result: Results[Event["type"]];
  if (
    state.definition.id !== judgmentDefinition.id ||
    state.definition.version !== judgmentDefinition.version
  )
    invalid("unsupported Judgment definition");
  if (event.type === "assignment.start") {
    if (state.report) invalid("Judge recommendation is already recorded and remains unapplied");
    if (previous && event.assignmentId !== state.assignmentId)
      invalid(`retry Judgment explicitly with assignmentId ${state.assignmentId}`);
    if (!previous && event.assignmentId) invalid("no matching Judgment assignment to retry");
    admit(
      event.policy,
      event.budget,
      Object.values(state.attempts).filter((attempt) => attempt.outcome === null).length,
    );
    if (Object.values(state.attempts).some((attempt) => attempt.outcome === null))
      invalid("Judgment already has a running attempt");
    if (state.attempts[event.attemptId]) invalid("duplicate Judgment attempt identity");
    const timeoutMs = Math.min(event.policy.attemptTimeMs, event.budget.timeMs);
    const artifactPath = `.xper/artifacts/judgment-verdict-${event.attemptId}.json`;
    state.attempts[event.attemptId] = { startedAt: now, timeoutMs, artifactPath, outcome: null };
    if (!previous)
      fact("assignment.created", {
        assignmentId: state.assignmentId,
        role: "judgment_day.judge",
        inputs: state.evaluation.artifacts.map((artifact) => artifact.artifact_id),
      });
    fact("attempt.started", {
      attemptId: event.attemptId,
      assignmentId: state.assignmentId,
      role: "judgment_day.judge",
      timeoutMs,
      selection: state.selection,
      model: state.model,
    });
    result = {
      workflow: "judgment",
      runId: state.runId,
      assignmentId: state.assignmentId,
      attemptId: event.attemptId,
      role: "judgment_day.judge",
      phase: "judgment_day",
      artifactKind: "judgment_verdict",
      artifactPath,
      selection: state.selection,
      ...(state.model ? { model: state.model } : {}),
      evaluation: state.evaluation,
      timeoutMs,
      budget: event.budget,
      inputArtifacts: state.evaluation.artifacts,
    };
  } else if (event.type === "attempt.finish") {
    const attempt = state.attempts[event.result.attemptId];
    if (!attempt) invalid("Judgment attempt is not registered");
    const outcome =
      event.result.outcome === "succeeded" && now - attempt.startedAt >= attempt.timeoutMs
        ? "timed_out"
        : event.result.outcome;
    if (attempt.outcome !== null) {
      if (
        attempt.outcome !== event.result.outcome &&
        !(attempt.outcome === "timed_out" && event.result.outcome === "succeeded")
      )
        invalid("Judgment attempt already has a different outcome");
      result = {
        attemptId: event.result.attemptId,
        outcome: attempt.outcome as FinishAttempt["outcome"],
        replayed: true,
      };
    } else {
      if (outcome === "succeeded") {
        if (
          !event.evidence ||
          !("artifactPath" in event.result) ||
          event.result.artifactPath !== attempt.artifactPath
        )
          invalid("Judgment report evidence is required");
        const report = parseJudgmentReport(
          event.evidence.content,
          state.evaluation,
          state.assignmentId,
        );
        state.report = {
          artifact_id: event.artifactId,
          kind: "judgment_verdict",
          version: 1,
          path: attempt.artifactPath,
          digest: event.evidence.digest,
          attemptId: event.result.attemptId,
          verdict: report.output.verdict,
        };
        fact("artifact.registered", { ...state.report, artifactId: event.artifactId });
        fact("judgment.reported", {
          artifactId: event.artifactId,
          verdict: report.output.verdict,
          evaluatedCommit: state.evaluation.evaluatedCommit,
          applied: false,
        });
        const edge = findTransition(judgmentDefinition, "judge", "judgment.reported");
        if (!edge) invalid("missing Judgment completion edge");
        fact("workflow.transition", {
          transitionId: edge.id,
          from: edge.from,
          to: edge.to,
          fromVisitId: state.instanceId,
          toVisitId: state.instanceId,
        });
        fact("workflow.completed", {
          artifactId: event.artifactId,
          outputKind: "judgment_verdict",
        });
      }
      attempt.outcome = outcome;
      fact("attempt.finished", {
        attemptId: event.result.attemptId,
        assignmentId: state.assignmentId,
        outcome,
        durationMs: Math.max(0, now - attempt.startedAt),
      });
      result = {
        attemptId: event.result.attemptId,
        outcome,
        artifactId: state.report?.artifact_id ?? null,
        ...(state.report
          ? {
              workflowCompleted: true,
              judgment: {
                verdict: state.report.verdict,
                evaluatedCommit: state.evaluation.evaluatedCommit,
                applied: false as const,
              },
            }
          : {}),
      };
    }
  } else {
    for (const [attemptId, attempt] of Object.entries(state.attempts))
      if (attempt.outcome === null) {
        attempt.outcome = "interrupted";
        fact("attempt.finished", {
          attemptId,
          assignmentId: state.assignmentId,
          outcome: "interrupted",
        });
      }
  }
  if (facts.length) {
    state.revision++;
    fact("workflow.position", { ...judgmentPosition(state) });
  }
  return { state, facts, result: structuredClone(result) as Results[E["type"]] };
}
