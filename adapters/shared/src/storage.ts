import { join } from "node:path";

/** Adapter namespaces are single directory names, independent of workflow identities. */
export function adapterDirectory(cwd: string, adapterId: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(adapterId)) throw new Error("Invalid adapter ID");
  return join(cwd, ".xper", adapterId);
}
