import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object, type ResolvedConfiguration } from "../bridge/xper-client.js";

function valid(value: unknown): value is ResolvedConfiguration {
  if (!object(value) || !object(value.adapterConfig)) return false;
  const routing = value.routing;
  return (
    routing === null ||
    (object(routing) &&
      typeof routing.profile === "string" &&
      typeof routing.context === "string" &&
      object(routing.routes) &&
      Object.values(routing.routes).every(
        (items) =>
          Array.isArray(items) &&
          items.length > 0 &&
          items.every(
            (item) =>
              object(item) &&
              [item.context, item.provider, item.model, item.thinking].every(
                (part) => typeof part === "string" && part.length > 0,
              ),
          ),
      ))
  );
}
/** Last prepared Rust configuration is cached separately from frozen run state. */
export class PreparedConfiguration {
  snapshot: ResolvedConfiguration | null = null;
  source: "defaults" | "cached" | "resolved" = "defaults";
  problem: string | undefined;
  readonly path: string;
  constructor(cwd: string) {
    this.path = join(cwd, ".xper", "pi", "configuration.json");
  }
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!object(value) || value.version !== 1 || !valid(value.configuration))
        throw new Error("invalid cache");
      this.snapshot = value.configuration;
      this.source = "cached";
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT")
        this.problem = "configuration cache unavailable; using Pi defaults";
    }
  }
  async update(configuration: ResolvedConfiguration): Promise<void> {
    this.snapshot = structuredClone(configuration);
    this.source = "resolved";
    this.problem = undefined;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, configuration }), { mode: 0o600 });
      await rename(temporary, this.path);
    } catch {
      this.problem = "resolved configuration is available in memory but could not be cached";
    }
  }
  summary(): string {
    const profile = this.snapshot?.routing?.profile;
    const source =
      this.source === "defaults"
        ? "Pi defaults; configuration is not prepared"
        : `${this.source} configuration${profile ? ` (profile ${profile})` : " (Pi model)"}`;
    return `${source}${this.problem ? `; ${this.problem}` : ""}`;
  }
}
