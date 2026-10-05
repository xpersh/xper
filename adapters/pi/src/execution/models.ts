import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailableModel, ModelSelection } from "../workflow/types.js";

export const execFileAsync = promisify(execFile);

export class ModelCatalogError extends Error {
  constructor(
    readonly code: "CATALOG_UNAVAILABLE" | "CATALOG_TIMEOUT" | "CATALOG_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

export function parseAvailableModels(stdout: string): AvailableModel[] {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^provider\s+model\s+/.test(lines[0] ?? "")) {
    if (/^No models (available|matching\b)/.test(stdout.trim())) return [];
    throw new ModelCatalogError("CATALOG_INVALID", "Pi model catalog has an unrecognized format");
  }
  return lines.slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6)
      throw new ModelCatalogError("CATALOG_INVALID", "Pi model catalog row is incomplete");
    const [provider, model, , , reasoning] = fields;
    if (!provider || !model || !["yes", "no"].includes(reasoning ?? "")) {
      throw new ModelCatalogError("CATALOG_INVALID", "Pi model catalog row is invalid");
    }
    return [{ provider, model, reasoning: reasoning === "yes" }];
  });
}

export async function listAvailableModels(
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AvailableModel[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.env.XPER_PI_COMMAND ?? "pi",
      ["--offline", "--list-models"],
      {
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 1_000_000,
        killSignal: "SIGKILL",
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ));
  } catch (error) {
    // Child output and error messages may contain provider configuration or secrets.
    const timedOut =
      !options.signal?.aborted &&
      error instanceof Error &&
      "killed" in error &&
      error.killed === true;
    throw new ModelCatalogError(
      timedOut ? "CATALOG_TIMEOUT" : "CATALOG_UNAVAILABLE",
      timedOut
        ? "Pi model catalog timed out; check Pi and retry"
        : "Pi model catalog is unavailable; check Pi installation and authentication",
    );
  }
  return parseAvailableModels(stdout);
}

export function piModelOptions(selection: ModelSelection): { model: string; thinking: string } {
  return { model: `${selection.provider}/${selection.model}`, thinking: selection.thinking };
}
