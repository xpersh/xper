import type { AdapterCheckpoint, DeliveryReconciliation } from "../checkpoint/types.js";
import type { ImplementationState } from "../implementation/state.js";

/** A Judge rework starts fresh delivery under the same sealed Plan. */
export function currentImplementation(checkpoint: AdapterCheckpoint, state: ImplementationState) {
  return (
    checkpoint.knowledge.accepted.plan === checkpoint.authorizedPlan?.artifactId &&
    state.planArtifactId === checkpoint.authorizedPlan?.artifactId &&
    state.reworkReportId === checkpoint.authorizedPlan?.reworkReportId
  );
}

export function feedbackArtifactId(source: DeliveryReconciliation): string {
  return source.judgmentArtifactId ?? source.verificationArtifactId ?? "";
}

export function cycleImplementations(checkpoint: AdapterCheckpoint) {
  return Object.fromEntries(
    Object.entries(checkpoint.implementations).map(([id, history]) => [
      id,
      history.filter((state) => currentImplementation(checkpoint, state)),
    ]),
  );
}
