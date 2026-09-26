import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Write one workspace-relative Brief without replacing an existing artifact. */
export async function saveDiscoveryBrief(
  cwd: string,
  attemptId: string,
  brief: string,
): Promise<string> {
  if (!attemptId.trim() || /[/\\\0]/.test(attemptId)) {
    throw new Error("Invalid attempt ID for a Discovery Brief filename");
  }
  const relative = `.xper/artifacts/discovery-brief-${attemptId}.md`;
  await mkdir(join(cwd, ".xper", "artifacts"), { recursive: true });
  await writeFile(join(cwd, relative), brief, { flag: "wx" });
  return relative;
}
