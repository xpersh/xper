import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function readEvidence(
  cwd: string,
  path: string,
): Promise<{ content: string; digest: string }> {
  if (isAbsolute(path)) throw new Error("artifact path must be relative to the workspace");
  const base = await realpath(join(cwd, ".xper", "artifacts"));
  const actual = await realpath(resolve(cwd, path));
  const rel = relative(base, actual);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("artifact must stay within .xper/artifacts");
  const info = await stat(actual);
  if (!info.isFile() || info.size > 1048576)
    throw new Error("artifact must be a file no larger than 1 MiB");
  const bytes = await readFile(actual);
  if (bytes.length > 1048576) throw new Error("artifact exceeds 1 MiB");
  const content = bytes.toString("utf8");
  if (!content.trim()) throw new Error("artifact is empty");
  return { content, digest: createHash("sha256").update(bytes).digest("hex") };
}
