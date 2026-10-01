import { judgmentPosition } from "./judgment/state.js";
import type { RecordedEvent } from "../bridge/xper-client.js";
import type { AdapterCheckpoint } from "./checkpoint/types.js";
import { implementationPosition } from "./implementation/selectors.js";
import { workflowPosition } from "./knowledge/selectors.js";
import { toRunSummary } from "./knowledge/state.js";
import type { RunStatus } from "./types.js";
import { invalid } from "./validation.js";
import { verificationPosition } from "./verification/selectors.js";

export function projectRunStatus(
  checkpoint: AdapterCheckpoint | null,
  timeline: RecordedEvent[],
  recording: { durability: RunStatus["durability"]; problem: string | undefined },
): RunStatus {
  const reconciliation = checkpoint?.reconciliations.at(-1);
  return {
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
    ...(checkpoint && Object.keys(checkpoint.implementations).length
      ? {
          implementations: Object.fromEntries(
            Object.entries(checkpoint.implementations).map(([incrementId, history]) => {
              const implementation = history.at(-1);
              if (!implementation) invalid("implementation history is empty");
              return [incrementId, implementationPosition(implementation)];
            }),
          ),
        }
      : {}),
    ...(checkpoint && Object.keys(checkpoint.verifications).length
      ? {
          verifications: Object.fromEntries(
            Object.entries(checkpoint.verifications).map(([incrementId, history]) => {
              const verification = history.at(-1);
              if (!verification) invalid("verification history is empty");
              return [incrementId, verificationPosition(verification)];
            }),
          ),
        }
      : {}),
    timeline: structuredClone(timeline),
    durability: recording.durability,
    ...(reconciliation
      ? {
          reconciliation: {
            status: reconciliation.status,
            reason: reconciliation.reason,
            verificationArtifactId: reconciliation.verificationArtifactId,
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
