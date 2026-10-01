import type { GitWorkspace } from "../../execution/workspace.js";
import type { CheckpointChange } from "../checkpoint/update.js";
import type { Evidence } from "../knowledge/events.js";
export type ArtifactWriter = (id: string, content: string, path: string) => Promise<string>;
/** Local effects shared by preparation functions; never expose mutable workflow state. */
export interface WorkflowEffects {
  readonly cwd: string;
  now(): number;
  id(): string;
  readArtifact(path: string): Promise<Evidence>;
  inspectWorkspace(cwd: string): Promise<GitWorkspace>;
}
export interface PreparedChange<Result> {
  change: CheckpointChange<Result>;
  now: number;
}
