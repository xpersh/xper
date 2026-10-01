import { checkArchitecture } from "./architecture.mjs";
import { readdirSync, readFileSync } from "node:fs";
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

const sources = new Map(
  filesWithExtension(join(adapterRoot, "src"), ".ts").map((file) => [
    relative(join(adapterRoot, "src"), file).replaceAll("\\", "/"),
    readFileSync(file, "utf8"),
  ]),
);
failures.push(...checkArchitecture(sources));

if (failures.length > 0) {
  console.error("Pi adapter architecture violations:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Pi adapter architecture boundaries are valid.");
}
