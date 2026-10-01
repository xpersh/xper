import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export interface GitWorkspace {
  root: string;
  head: string;
  clean: boolean;
  status: string;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return stdout.trim();
}

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspace> {
  let root: string;
  let head: string;
  try {
    [root, head] = await Promise.all([
      git(cwd, ["rev-parse", "--show-toplevel"]),
      git(cwd, ["rev-parse", "HEAD"]),
    ]);
  } catch {
    throw new Error("implementation requires an existing Git checkout with a local commit");
  }
  if (resolve(await realpath(root)) !== resolve(await realpath(cwd)))
    throw new Error("implementation must run from the root of its dedicated Git checkout");
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { root, head, clean: status.length === 0, status };
}

export async function isDescendant(cwd: string, base: string, head: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", base, head], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const output = await git(cwd, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head]);
  return output ? output.split("\n").filter(Boolean) : [];
}
