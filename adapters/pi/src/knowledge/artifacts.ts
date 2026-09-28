import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Write one workspace-relative phase artifact without replacing an existing artifact. */
export async function saveArtifact(
  cwd: string,
  attemptId: string,
  brief: string,
  artifactPath?: string,
): Promise<string> {
  if (!attemptId.trim() || /[/\\\0]/.test(attemptId)) {
    throw new Error("Invalid attempt ID for an artifact filename");
  }
  const relative = artifactPath ?? `.xper/artifacts/discovery-brief-${attemptId}.md`;
  if (
    !/^\.xper\/artifacts\/[a-z-]+-[a-zA-Z0-9-]+\.(md|json)$/.test(relative) ||
    !relative.endsWith(`-${attemptId}.${relative.endsWith(".json") ? "json" : "md"}`)
  ) {
    throw new Error("Invalid core artifact path");
  }
  if (relative.endsWith(".json")) JSON.parse(brief);
  await mkdir(join(cwd, ".xper", "artifacts"), { recursive: true });
  await writeFile(join(cwd, relative), brief, { flag: "wx" });
  return relative;
}
