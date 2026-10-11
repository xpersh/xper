import { unresolvedBudgetReason } from "./delivery/budget.js";
import { cycleImplementations } from "./delivery/cycle.js";
import { judgmentPosition } from "./judgment/state.js";
import type { RecordedEvent } from "../bridge/xper-client.js";
import type { AdapterCheckpoint } from "./checkpoint/types.js";
import { implementationPosition } from "./implementation/selectors.js";
import { workflowPosition } from "./knowledge/selectors.js";
import { toRunSummary } from "./knowledge/state.js";
import type { RunStatus } from "./types.js";
import { verificationPosition } from "./verification/selectors.js";

export function projectRunStatus(
  checkpoint: AdapterCheckpoint | null,
  timeline: RecordedEvent[],
  recording: { durability: RunStatus["durability"]; problem: string | undefined },
  now: number,
): RunStatus {
  const reconciliation = checkpoint?.reconciliations.at(-1);
  const current = checkpoint ? cycleImplementations(checkpoint) : {};
  const implementations = Object.fromEntries(
    Object.entries(current).flatMap(([id, history]) => {
      const latest = history.at(-1);
      return latest ? [[id, implementationPosition(latest)]] : [];
    }),
  );
  const verifications = Object.fromEntries(
    Object.entries(checkpoint?.verifications ?? {}).flatMap(([id, history]) => {
      const latest = history.findLast(
        (state) =>
          state.implementation.instanceId === current[id]?.at(-1)?.instanceId ||
          (state.lifecycle.status === "completed" &&
            state.lifecycle.artifactId === reconciliation?.verificationArtifactId),
      );
      return latest ? [[id, verificationPosition(latest)]] : [];
    }),
  );
  const feedback = checkpoint?.judgmentHistory.at(-1)?.decision;
  const unresolved =
    checkpoint && feedback && !checkpoint.closure && !checkpoint.judgment?.report
      ? unresolvedBudgetReason(checkpoint, now)
      : null;
  return {
    ...(feedback ? { feedback: structuredClone(feedback) } : {}),
    ...(unresolved ? { unresolvedReason: unresolved } : {}),
    ...(checkpoint?.closure ? { closure: structuredClone(checkpoint.closure) } : {}),
    ...(checkpoint?.judgment
      ? {
          judgment: {
            ...judgmentPosition(checkpoint.judgment),
            assignmentId: checkpoint.judgment.assignmentId,
            evaluatedCommit: checkpoint.judgment.evaluation.evaluatedCommit,
            applied: checkpoint.closure !== null,
            ...(checkpoint.judgment.report
              ? {
                  verdict: checkpoint.judgment.report.verdict,
                  artifactPath: checkpoint.judgment.report.path,
                }
              : {}),
          },
        }
      : {}),
    run: checkpoint ? toRunSummary(checkpoint.knowledge) : null,
    ...(checkpoint ? { workflow: workflowPosition(checkpoint.knowledge) } : {}),
    ...(checkpoint && Object.keys(checkpoint.implementations).length ? { implementations } : {}),
    ...(checkpoint && Object.keys(checkpoint.verifications).length ? { verifications } : {}),
    timeline: structuredClone(timeline),
    durability: recording.durability,
    ...(reconciliation
      ? {
          reconciliation: {
            status: reconciliation.status,
            reason: reconciliation.reason,
            ...(reconciliation.judgmentArtifactId
              ? { judgmentArtifactId: reconciliation.judgmentArtifactId }
              : { verificationArtifactId: reconciliation.verificationArtifactId as string }),
            previousPlanArtifactId: reconciliation.previousPlanArtifactId,
            ...(reconciliation.revisedPlanArtifactId
              ? { revisedPlanArtifactId: reconciliation.revisedPlanArtifactId }
              : {}),
            ...(reconciliation.resumeCommit ? { resumeCommit: reconciliation.resumeCommit } : {}),
          },
        }
      : {}),
    ...(recording.problem ? { degradedReason: recording.problem } : {}),
  };
}
