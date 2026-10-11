import { cycleImplementations } from "./cycle.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { JudgmentEvaluation } from "../types.js";
import { invalid } from "../validation.js";
import { registeredArtifact } from "./artifacts.js";
import { assertDeliveryReady, deliveryFrontier, satisfiedAssignmentArtifacts } from "./frontier.js";
import { verifiedDeliveryTip } from "./history.js";

/** Compose only the active Plan's verified delivery evidence. Admission also checks the sealed DAG. */
export function judgmentEvaluation(
  checkpoint: AdapterCheckpoint,
): Omit<JudgmentEvaluation, "logs"> {
  assertDeliveryReady(checkpoint);
  if (deliveryFrontier(checkpoint)) invalid("Judgment requires every increment to be verified");
  const planArtifactId = checkpoint.authorizedPlan?.artifactId;
  if (!planArtifactId) invalid("Judgment requires an authorized Plan");
  const satisfied = satisfiedAssignmentArtifacts(checkpoint);
  const implementations = cycleImplementations(checkpoint);
  const reviews = Object.values(checkpoint.verifications)
    .map((history) =>
      history.findLast(
        (state) =>
          state.planArtifactId === planArtifactId &&
          implementations[state.incrementId]?.some(
            (implementation) => implementation.instanceId === state.implementation.instanceId,
          ),
      ),
    )
    .filter((state) => state !== undefined);
  const tip = verifiedDeliveryTip(
    implementations,
    checkpoint.verifications,
    planArtifactId,
    checkpoint.authorizedPlan?.baseCommit,
  );
  const commits = new Set(reviews.map((state) => state.implementation.evaluatedCommit));
  const roots = reviews.filter((state) => !commits.has(state.implementation.baseCommit));
  const root = roots[0];
  if (!tip || (!checkpoint.authorizedPlan?.reworkReportId && (!root || roots.length !== 1)))
    invalid("Judgment requires one verified delivery chain");
  const source = checkpoint.judgmentHistory.find(
    (entry) => entry.decision.reportId === checkpoint.authorizedPlan?.reworkReportId,
  );
  return {
    planArtifactId,
    incrementIds: reviews.map((state) => state.incrementId),
    criterionIds: [
      ...new Set(
        reviews.flatMap((state) => state.assignment.criteria.map((criterion) => criterion.id)),
      ),
    ],
    artifacts: [
      ...new Set([
        ...Object.values(checkpoint.knowledge.accepted),
        ...satisfied.values(),
        ...(source
          ? [
              source.decision.reportId,
              ...(source.decision.resolution ? [source.decision.resolution.artifact_id] : []),
            ]
          : []),
      ]),
    ].map((id) => {
      const { artifact_id, kind, path, version, digest } = registeredArtifact(checkpoint, id);
      return { artifact_id, kind, path, version, digest };
    }),
    baseCommit:
      source?.state.evaluation.baseCommit ??
      root?.implementation.baseCommit ??
      invalid("Judgment base is unavailable"),
    evaluatedCommit: tip,
  };
}

export function validateJudgmentReferences(checkpoint: AdapterCheckpoint): void {
  const state = checkpoint.judgment;
  if (!state) return;
  const { logs: _logs, ...evaluation } = state.evaluation;
  if (
    state.runId !== checkpoint.knowledge.run_id ||
    JSON.stringify(state.selection) !==
      JSON.stringify(checkpoint.knowledge.routing?.routes["judgment_day.judge"]?.[0] ?? null) ||
    JSON.stringify(evaluation) !== JSON.stringify(judgmentEvaluation(checkpoint))
  )
    invalid("Judgment checkpoint does not match delivery evidence");
  const owners = [
    checkpoint.knowledge,
    ...Object.values(checkpoint.implementations).flat(),
    ...Object.values(checkpoint.verifications).flat(),
  ];
  if (
    owners.some(
      (owner) =>
        owner.instanceId === state.instanceId ||
        Object.keys(state.attempts).some((id) => Object.hasOwn(owner.attempts, id)) ||
        (state.report && Object.hasOwn(owner.artifacts, state.report.artifact_id)),
    )
  )
    invalid("duplicate Judgment checkpoint identity");
}
