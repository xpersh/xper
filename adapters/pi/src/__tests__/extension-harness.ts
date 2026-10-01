import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import type { createXperExtension } from "../extension.js";

const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const binary = resolve(workspace, "target/debug/xper");

const temporaryWorkspaces: string[] = [];
after(() => {
  for (const directory of temporaryWorkspaces) rmSync(directory, { recursive: true, force: true });
});
function fakePi(cwd?: string) {
  if (!cwd) {
    cwd = mkdtempSync(join(tmpdir(), "xper-extension-"));
    temporaryWorkspaces.push(cwd);
  }
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
  const prompts: string[] = [];
  const answers: Array<string | undefined> = [];
  let command: ((args: string, ctx: unknown) => void) | undefined;
  let tool:
    | {
        execute: (
          id: string,
          params: { task: string; timeoutSeconds?: number; assignmentId?: string },
          signal: AbortSignal,
          onUpdate: unknown,
          ctx: unknown,
        ) => Promise<{ details: Record<string, unknown> }>;
      }
    | undefined;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      notify: (message: string) => messages.push(message),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      input: async (title: string) => {
        prompts.push(title);
        return answers.shift();
      },
    },
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => void }) => {
      assert.equal(name, "xper");
      command = options.handler;
    },
    registerTool: (value: typeof tool) => {
      tool = value;
    },
  } as Parameters<typeof createXperExtension>[0];
  return {
    pi,
    ctx,
    messages,
    statuses,
    prompts,
    answers,
    async emit(event: string, payload: unknown = {}) {
      const handler = handlers.get(event);
      assert(handler, `missing ${event} handler`);
      await handler(payload, ctx);
    },
    async connected() {
      await until(() => statuses.at(-1) === "xper connected");
    },
    async status() {
      assert(command);
      await command("status", ctx);
      return messages.at(-1) ?? "";
    },
    async command(args: string) {
      assert(command);
      await command(args, ctx);
      return messages.at(-1) ?? "";
    },
    async delegate(
      params: { task: string; timeoutSeconds?: number; assignmentId?: string },
      signal = new AbortController().signal,
    ) {
      assert(tool);
      return tool.execute("pi-tool-call-1", params, signal, undefined, ctx);
    },
  };
}

function pidFrom(status: string): number {
  const match = status.match(/pid (\d+)/);
  assert(match, status);
  return Number(match[1]);
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(await predicate(), "condition was not reached");
}

export { binary, fakePi, pidFrom, temporaryWorkspaces, until, workspace };
