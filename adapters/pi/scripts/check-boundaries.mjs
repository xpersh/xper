import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

const adapterManifest = JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8"));
const productionDependencies = Object.keys(adapterManifest.dependencies ?? {});
for (const dependency of productionDependencies) {
  if (dependency.startsWith("@xper/") && dependency !== "@xper/protocol") {
    failures.push(`Pi adapter depends on private xper package ${dependency}`);
  }
}

function filesWithExtension(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return filesWithExtension(path, extension);
    }
    return entry.name.endsWith(extension) ? [path] : [];
  });
}

const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
for (const sourceFile of filesWithExtension(join(adapterRoot, "src"), ".ts")) {
  const source = readFileSync(sourceFile, "utf8");
  const adapterPath = relative(join(adapterRoot, "src"), sourceFile).replaceAll("\\", "/");
  if (
    !adapterPath.startsWith("__tests__/") &&
    adapterPath !== "bridge/xper-client.ts" &&
    /\.request\s*\(\s*["'](?:run\.status|event\.append|configuration\.resolve|profile\.inspect)["']/.test(
      source,
    )
  ) {
    failures.push(
      `${adapterPath} must call configuration and recording operations through the typed xper client`,
    );
  }
  if (
    !adapterPath.startsWith("__tests__/") &&
    /["'](?:run\.start|run\.advance|assignment\.start|attempt\.finish)["']/.test(source)
  ) {
    failures.push(`${adapterPath} must keep workflow commands inside Pi, not in RPC messages`);
  }
  if (
    adapterPath.startsWith("workflow/") &&
    adapterPath !== "workflow/journal.ts" &&
    /\.(?:appendEvents|resolveConfiguration|inspectProfile|getRunStatus|request)\s*\(/.test(source)
  ) {
    failures.push(
      `${adapterPath} must use local execution state and prepared configuration; only the journal delivers telemetry`,
    );
  }
  if (
    (adapterPath.startsWith("actions/") || adapterPath.startsWith("pi/xper-")) &&
    /await\s+[^;\n]*(?:recordUsage|waitForRecording|waitForIdle)\s*(?:\?\.)?\(/.test(source)
  ) {
    failures.push(`${adapterPath} must not await telemetry delivery`);
  }
  for (const match of source.matchAll(importPattern)) {
    if (adapterPath.startsWith("workflow/") && match[1]?.endsWith("/bridge/client.js")) {
      failures.push(`${adapterPath} must not depend on the bridge process`);
    }
    if (adapterPath.startsWith("bridge/") && /(?:^|\/)workflow\//.test(match[1] ?? "")) {
      failures.push(`${adapterPath} must not depend on Pi workflow policy`);
    }
    const specifier = match[1];
    if (
      adapterPath.startsWith("actions/") &&
      (specifier?.startsWith("node:") ||
        /(?:^|\/)(?:pi|knowledge)\//.test(specifier ?? "") ||
        specifier?.endsWith("/bridge/client.js"))
    ) {
      failures.push(`${adapterPath} must receive Pi execution and I/O through its dependencies`);
    }
    const importsPrivateXperPackage =
      specifier?.startsWith("@xper/") && specifier !== "@xper/protocol";
    if (
      specifier?.includes("/crates/") ||
      /^xper-(?!protocol(?:$|\/))/.test(specifier ?? "") ||
      importsPrivateXperPackage
    ) {
      failures.push(
        `${relative(adapterRoot, sourceFile)} imports private core module ${specifier}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Pi adapter architecture violations:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Pi adapter architecture boundaries are valid.");
}
