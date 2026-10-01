import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { registeredArtifact } from "../delivery/artifacts.js";
import type { Evidence, GateEvidence } from "../knowledge/events.js";
import { gateArtifact } from "../knowledge/selectors.js";
import { invalid } from "../validation.js";

export type ArtifactReader = (path: string) => Promise<Evidence>;
export async function readRegisteredArtifact(
  checkpoint: AdapterCheckpoint,
  readArtifact: ArtifactReader,
  id: string,
): Promise<Evidence> {
  const artifact = registeredArtifact(checkpoint, id);
  const evidence = await readArtifact(artifact.path);
  if (evidence.digest !== artifact.digest) invalid("artifact changed after registration");
  return evidence;
}
export async function prepareGateEvidence(
  checkpoint: AdapterCheckpoint,
  readArtifact: ArtifactReader,
): Promise<GateEvidence> {
  const state = checkpoint.knowledge;
  const artifact = gateArtifact(state);
  if (!artifact) return { artifacts: {} };
  const artifacts: Record<string, Evidence> = {};
  try {
    for (const id of new Set([
      artifact.artifact_id,
      ...artifact.inputs,
      ...Object.values(state.accepted),
    ]))
      artifacts[id] = await readRegisteredArtifact(checkpoint, readArtifact, id);
    return { artifacts };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "artifact unavailable" };
  }
}
