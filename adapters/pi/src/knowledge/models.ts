import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailableModel, ModelSelection } from "../bridge/xper-client.js";

const execFileAsync = promisify(execFile);

/** Query the same Pi model catalog and authentication state used by child runs. */
export async function listAvailableModels(): Promise<AvailableModel[]> {
  const { stdout } = await execFileAsync(
    process.env.XPER_PI_COMMAND ?? "pi",
    ["--offline", "--list-models"],
    { timeout: 10_000, maxBuffer: 1_000_000 },
  );
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^provider\s+model\s+/.test(lines[0] ?? "")) {
    if (stdout.includes("No models available")) return [];
    throw new Error("Pi model catalog has an unrecognized format");
  }
  return lines.slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) throw new Error("Pi model catalog row is incomplete");
    const [provider, model, , , reasoning] = fields;
    if (!provider || !model || !["yes", "no"].includes(reasoning ?? "")) {
      throw new Error("Pi model catalog row is invalid");
    }
    return [{ provider, model, reasoning: reasoning === "yes" }];
  });
}

/** Translate a neutral selection into the flags accepted by Pi. */
export function piModelOptions(selection: ModelSelection): { model: string; thinking: string } {
  return { model: `${selection.provider}/${selection.model}`, thinking: selection.thinking };
}
