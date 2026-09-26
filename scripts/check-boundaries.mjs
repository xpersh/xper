import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }),
);
const packages = new Map(metadata.packages.map((rustPackage) => [rustPackage.name, rustPackage]));

function localDependencies(packageName) {
  const rustPackage = packages.get(packageName);
  if (!rustPackage) {
    failures.push(`missing workspace crate: ${packageName}`);
    return [];
  }

  return rustPackage.dependencies
    .map((dependency) => dependency.name)
    .filter((dependencyName) => packages.has(dependencyName))
    .sort();
}

function requireExactDependencies(packageName, expected) {
  const actual = localDependencies(packageName);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(`${packageName} xper dependencies: expected ${wanted}, found ${actual}`);
  }
}

requireExactDependencies("xper-domain", []);
requireExactDependencies("xper-application", ["xper-domain"]);
requireExactDependencies("xper-protocol", []);
requireExactDependencies("xper-config", ["xper-application"]);
requireExactDependencies("xper-store-sqlite", ["xper-application", "xper-domain"]);
requireExactDependencies("xper-cli", [
  "xper-application",
  "xper-config",
  "xper-domain",
  "xper-protocol",
  "xper-store-sqlite",
]);

const domainPackage = packages.get("xper-domain");
if (domainPackage && domainPackage.dependencies.length > 0) {
  failures.push("xper-domain must not have external or workspace dependencies");
}

const forbiddenHarnessDependency = /(^|[-_])(pi|opencode|claude|codex)([-_]|$)/i;
for (const rustPackage of packages.values()) {
  for (const dependency of rustPackage.dependencies) {
    if (forbiddenHarnessDependency.test(dependency.name)) {
      failures.push(`${rustPackage.name} imports harness dependency ${dependency.name}`);
    }
  }
}

const adapterRoot = join(workspaceRoot, "adapters/pi");
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

for (const sourceFile of filesWithExtension(join(workspaceRoot, "crates/xper-domain/src"), ".rs")) {
  const source = readFileSync(sourceFile, "utf8");
  for (const forbiddenApi of ["std::fs::", "std::io::", "std::net::", "std::process::"]) {
    if (source.includes(forbiddenApi)) {
      failures.push(
        `${relative(workspaceRoot, sourceFile)} uses forbidden I/O API ${forbiddenApi}`,
      );
    }
  }
}

// Application code coordinates injected ports, including time and IDs. Catch
// direct and grouped std imports, not only crate dependency violations.
for (const sourceFile of filesWithExtension(
  join(workspaceRoot, "crates/xper-application/src"),
  ".rs",
)) {
  const source = readFileSync(sourceFile, "utf8");
  const directIo = /\bstd\s*::\s*(?:fs|io|net|process|thread|env)\b/.test(source);
  const groupedIo = [...source.matchAll(/\buse\s+std\s*::\s*\{([^;]+)\}\s*;/g)].some((match) =>
    /\b(?:fs|io|net|process|thread|env)\b/.test(match[1]),
  );
  if (directIo || groupedIo || /\b(?:SystemTime|Instant)::now\s*\(/.test(source)) {
    failures.push(`${relative(workspaceRoot, sourceFile)} must access I/O and time through ports`);
  }
  if (/\b(?:serde_json|xper_protocol)\s*::/.test(source)) {
    failures.push(`${relative(workspaceRoot, sourceFile)} must not handle JSON/RPC transport`);
  }
}

// CLI interfaces translate requests and present results. Composition and local
// port implementations may depend on concrete adapters, but no CLI file may
// construct workflow events or commit a workflow boundary itself.
for (const sourceFile of filesWithExtension(join(workspaceRoot, "crates/xper-cli/src"), ".rs")) {
  const source = readFileSync(sourceFile, "utf8");
  const path = relative(workspaceRoot, sourceFile).replaceAll("\\", "/");
  if (/\bEventKind\b|\.append_boundary(?:_and_bind_session)?\s*\(|\bRun::start\s*\(/.test(source)) {
    failures.push(`${path} must delegate workflow mutations to application use cases`);
  }
  if (path.includes("/infrastructure/") || path.endsWith("/composition.rs")) continue;
  if (/\bxper_(?:domain|store_sqlite|config)\s*::/.test(source)) {
    failures.push(
      `${path} must obtain concrete dependencies through composition or infrastructure`,
    );
  }
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
        /(?:^|\/)(?:pi|discovery)\//.test(specifier ?? "") ||
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
        `${relative(workspaceRoot, sourceFile)} imports private core module ${specifier}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Dependency boundary violations:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Dependency boundaries are valid.");
}
