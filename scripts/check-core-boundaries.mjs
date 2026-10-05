import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
requireExactDependencies("xper-store-sqlite", ["xper-application"]);
requireExactDependencies("xper-cli", [
  "xper-application",
  "xper-config",
  "xper-protocol",
  "xper-store-sqlite",
]);

const domainPackage = packages.get("xper-domain");
if (domainPackage && domainPackage.dependencies.length > 0) {
  failures.push("xper-domain must not have external or workspace dependencies");
}

const forbiddenHarnessDependency = /(^|[-_])(pi|opencode|claude|codex)([-_]|$)/i;
const terminalUiDependency = /^(?:ratatui|crossterm)(?:$|[-_])/;
for (const rustPackage of packages.values()) {
  for (const dependency of rustPackage.dependencies) {
    if (forbiddenHarnessDependency.test(dependency.name)) {
      failures.push(`${rustPackage.name} imports harness dependency ${dependency.name}`);
    }
    if (rustPackage.name !== "xper-cli" && terminalUiDependency.test(dependency.name)) {
      failures.push(
        `${rustPackage.name} must not depend on terminal UI library ${dependency.name}`,
      );
    }
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
  // JSON values carry opaque adapter metadata. Parsing and RPC translation
  // remain infrastructure responsibilities; retaining a payload is not policy.
  if (
    /\bserde_json\s*::\s*(?:from_|to_|json\s*!)/.test(source) ||
    /\bxper_protocol\s*::/.test(source)
  ) {
    failures.push(`${relative(workspaceRoot, sourceFile)} must not handle JSON/RPC transport`);
  }
}

// The recording core must remain independent of adapter workflow semantics.
// These guards catch a reintroduction of the removed knowledge policy. This
// supplements, rather than replaces, responsibility review for new rules.
for (const sourceFile of filesWithExtension(join(workspaceRoot, "crates"), ".rs").filter((path) =>
  path.includes("/src/"),
)) {
  const source = readFileSync(sourceFile, "utf8");
  const path = relative(workspaceRoot, sourceFile).replaceAll("\\", "/");
  // Views, input events and terminal lifecycle are infrastructure. The CLI
  // composition root may call that adapter, but must not handle its UI types.
  if (
    !path.startsWith("crates/xper-cli/src/infrastructure/") &&
    /\b(?:ratatui(?:_\w+)?|crossterm(?:_\w+)?)\s*(?:::|;)/.test(source)
  ) {
    failures.push(`${path} must keep terminal UI dependencies in CLI infrastructure`);
  }
  if (
    /\b(?:WorkflowPolicy|KnowledgeArtifact|ArtifactReader|is_allowed_transition|DefinitionContract|ExecutionPlan)\b|\bPhase::/.test(
      source,
    )
  ) {
    failures.push(`${relative(workspaceRoot, sourceFile)} contains adapter-owned workflow policy`);
  }
}

// CLI interfaces translate requests and present results. Only application
// operations may invoke the recording repository's append operation.
for (const sourceFile of filesWithExtension(join(workspaceRoot, "crates/xper-cli/src"), ".rs")) {
  const source = readFileSync(sourceFile, "utf8");
  const path = relative(workspaceRoot, sourceFile).replaceAll("\\", "/");
  if (/\.append_events\s*\(|\.append_boundary(?:_and_bind_session)?\s*\(/.test(source)) {
    failures.push(`${path} must delegate recording mutations to application use cases`);
  }
  if (path.includes("/infrastructure/") || path.endsWith("/composition.rs")) continue;
  if (/\bxper_(?:domain|store_sqlite|config)\s*::/.test(source)) {
    failures.push(
      `${path} must obtain concrete dependencies through composition or infrastructure`,
    );
  }
}

if (failures.length > 0) {
  console.error("Core architecture violations:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Core architecture boundaries are valid.");
}
