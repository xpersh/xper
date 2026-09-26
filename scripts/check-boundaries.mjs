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

const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
for (const sourceFile of filesWithExtension(join(adapterRoot, "src"), ".ts")) {
  const source = readFileSync(sourceFile, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
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
