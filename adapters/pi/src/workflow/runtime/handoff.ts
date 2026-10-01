import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { parseImplementationResult } from "../implementation/result.js";
import type { ImplementationState } from "../implementation/state.js";
import { parseDocument } from "../knowledge/contracts.js";
import { invalid } from "../validation.js";
import { readRegisteredArtifact } from "./evidence.js";

import {
  implementationHandoff,
  requireImplementationPlan,
  requireVerificationPlan,
  verificationHandoff,
  type KnowledgeDocuments,
} from "../delivery/handoff.js";
import type { ArtifactReader } from "./evidence.js";
async function readKnowledgeDocuments(
  checkpoint: AdapterCheckpoint,
  readArtifact: ArtifactReader,
): Promise<KnowledgeDocuments> {
  const knowledge = checkpoint.knowledge;
  const documents: Partial<Record<string, ReturnType<typeof parseDocument>>> = {};
  for (const [phase, id] of Object.entries(knowledge.accepted)) {
    const artifact = knowledge.artifacts[id];
    if (!artifact) invalid("accepted knowledge artifact is not registered");
    const evidence = await readRegisteredArtifact(checkpoint, readArtifact, id);
    if (phase !== "discovery") {
      try {
        documents[phase] = parseDocument(evidence.content, artifact.inputs);
      } catch (error) {
        invalid(
          `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid knowledge artifact"})`,
        );
      }
    }
  }

  return documents;
}
export async function prepareImplementationHandoff(
  checkpoint: AdapterCheckpoint,
  readArtifact: ArtifactReader,
  now: number,
) {
  requireImplementationPlan(checkpoint);
  const documents = await readKnowledgeDocuments(checkpoint, readArtifact);
  return implementationHandoff(checkpoint, documents, now);
}
export async function prepareVerificationHandoff(
  checkpoint: AdapterCheckpoint,
  readArtifact: ArtifactReader,
  implementation: ImplementationState,
) {
  requireVerificationPlan(checkpoint, implementation);
  const documents = await readKnowledgeDocuments(checkpoint, readArtifact);
  // Validate the Plan before reading the implementation result, preserving diagnostics.
  if (documents.plan?.output.kind !== "execution_plan")
    invalid("sealed Plan is unsupported; replan before delivery");
  if (implementation.lifecycle.status !== "completed")
    invalid("the increment has not produced an implementation result");
  const implementationArtifactId = implementation.lifecycle.artifactId;
  if (!implementation.artifacts[implementationArtifactId])
    invalid("implementation result evidence is unavailable");
  const evidence = await readRegisteredArtifact(checkpoint, readArtifact, implementationArtifactId);
  const report = parseImplementationResult(evidence.content, implementation);
  return verificationHandoff(checkpoint, implementation, documents, report);
}
