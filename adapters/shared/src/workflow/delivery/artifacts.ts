import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { invalid } from "../validation.js";
export function registeredArtifact(
  checkpoint: AdapterCheckpoint,
  id: string,
): {
  artifact_id: string;
  kind: string;
  path: string;
  version: number;
  digest: string;
} {
  if (checkpoint.judgment?.report?.artifact_id === id) return checkpoint.judgment.report;
  const historical = checkpoint.judgmentHistory.find(
    (entry) => entry.state.report?.artifact_id === id,
  )?.state.report;
  if (historical) return historical;
  const resolution = [
    checkpoint.closure,
    ...checkpoint.judgmentHistory.map((entry) => entry.decision),
  ].find((decision) => decision?.resolution?.artifact_id === id)?.resolution;
  if (resolution) return resolution;
  const knowledge = checkpoint.knowledge.artifacts[id];
  if (knowledge) return knowledge;
  const imported = checkpoint.knowledge.imports[id];
  if (imported) return imported;
  for (const history of Object.values(checkpoint.implementations))
    for (const implementation of history) {
      const artifact = implementation.artifacts[id];
      if (artifact) return artifact;
    }
  for (const history of Object.values(checkpoint.verifications))
    for (const verification of history) {
      const artifact = verification.artifacts[id];
      if (artifact) return artifact;
    }
  invalid("input artifact is not registered");
}
export function artifactInput(checkpoint: AdapterCheckpoint, id: string) {
  const artifact = registeredArtifact(checkpoint, id);
  return {
    artifact_id: artifact.artifact_id,
    kind: artifact.kind,
    path: artifact.path,
    version: artifact.version,
  };
}
