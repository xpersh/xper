import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Renamed modules and suites must not survive as stale compiled entry points.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "--project", "tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
