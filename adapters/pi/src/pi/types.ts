import type { PiToolEndEvent } from "./observations.js";

/** The small part of Pi's extension API used by this adapter. */
export interface PiContext {
  cwd: string;
  mode: string;
  model?: { provider: string; id: string };
  sessionManager: { getSessionId(): string };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

export interface PiExtensionAPI {
  on(
    event: "session_start",
    handler: (event: { reason: string }, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: { reason: string }, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_compact_failed",
    handler: (event: { type: string }, ctx: PiContext) => void,
  ): void;
  on(
    event: "tool_execution_start",
    handler: (event: { toolName: string; toolCallId: string }, ctx: PiContext) => void,
  ): void;
  on(event: "tool_execution_end", handler: (event: PiToolEndEvent, ctx: PiContext) => void): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: PiContext) => void | Promise<void>;
    },
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: { task: string; timeoutSeconds?: number; assignmentId?: string },
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: PiContext,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }>;
  }): void;
}
