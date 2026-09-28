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
    /\.request\s*\(\s*["'](?:run\.(?:start|status|advance)|assignment\.start|attempt\.finish)["']/.test(
      source,
    )
  ) {
    failures.push(`${adapterPath} must call workflow operations through the typed xper client`);
  }
  for (const match of source.matchAll(importPattern)) {
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
