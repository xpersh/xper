import { posix } from "node:path";
import ts from "typescript";

const sharedEntrypoints = new Set([
  "@xper/adapter-shared",
  "@xper/adapter-shared/workflow",
  "@xper/adapter-shared/actions",
  "@xper/adapter-shared/execution",
  "@xper/adapter-shared/bridge",
  "@xper/adapter-shared/configuration",
]);

export function checkDependencies(dependencies) {
  return dependencies
    .filter(
      (dependency) =>
        dependency.startsWith("@xper/") &&
        dependency !== "@xper/protocol" &&
        dependency !== "@xper/adapter-shared",
    )
    .map((dependency) => `Pi adapter depends on private xper package ${dependency}`);
}

/** Resolve import and re-export edges, including type and dynamic imports. */
export function moduleImports(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edges = [];
  function add(specifier, typeOnly) {
    const target = specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/, ".ts")
      : null;
    edges.push({ specifier, typeOnly, target });
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // With verbatimModuleSyntax, inline type specifiers still emit an empty
      // import/export and evaluate the dependency. Only declaration-level types erase it.
      add(node.moduleSpecifier.text, Boolean(node.isTypeOnly || node.importClause?.isTypeOnly));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, Boolean(node.isTypeOnly));
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(ast) === "require")
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) add(argument.text, false);
      else add("<dynamic module>", false);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return edges;
}

export function checkArchitecture(sources) {
  const failures = [];
  const graph = new Map();
  for (const [adapterPath, source] of sources) {
    if (adapterPath.startsWith("__tests__/")) continue;
    const imports = moduleImports(adapterPath, source);
    graph.set(
      adapterPath,
      imports.map((edge) => edge.target).filter((target) => sources.has(target)),
    );
    if (
      /\.request\s*\(\s*["'](?:run\.status|event\.append|configuration\.resolve|profile\.inspect)["']/.test(
        source,
      )
    ) {
      failures.push(
        `${adapterPath} must call configuration and recording operations through the typed xper client`,
      );
    }
    if (
      /\.(?:request|call)\s*(?:<[^>]+>)?\s*\(\s*["'](?:run\.start|run\.advance|assignment\.start|attempt\.finish)["']/.test(
        source,
      )
    ) {
      failures.push(
        `${adapterPath} must keep workflow commands inside adapters, not in RPC messages`,
      );
    }
    if (
      adapterPath.startsWith("pi/xper-") &&
      /await\s+[^;\n]*(?:recordUsage|waitForRecording|waitForIdle)\s*(?:\?\.)?\(/.test(source)
    ) {
      failures.push(`${adapterPath} must not await telemetry delivery`);
    }
    for (const { specifier, typeOnly, target } of imports) {
      const shared = sharedEntrypoints.has(specifier);
      if (target?.startsWith("../")) {
        failures.push(`${adapterPath} must use public package entrypoints (${specifier})`);
      }
      if (
        (specifier.startsWith("@xper/") && specifier !== "@xper/protocol" && !shared) ||
        specifier.includes("/crates/") ||
        /^xper-(?!protocol(?:$|\/))/.test(specifier)
      ) {
        failures.push(`${adapterPath} imports private xper module ${specifier}`);
      }
      if (
        adapterPath.startsWith("inspection/") &&
        ((!typeOnly &&
          target &&
          !target.startsWith("inspection/") &&
          target !== "execution/models.ts") ||
          (shared &&
            specifier !== "@xper/adapter-shared" &&
            !(typeOnly && specifier === "@xper/adapter-shared/bridge")))
      ) {
        failures.push(
          `${adapterPath} may inspect definitions and models, but must not start workflow or recording services`,
        );
      }
      if (
        adapterPath.startsWith("execution/") &&
        !typeOnly &&
        ((shared &&
          specifier !== "@xper/adapter-shared" &&
          specifier !== "@xper/adapter-shared/execution") ||
          target?.startsWith("pi/"))
      ) {
        failures.push(
          `${adapterPath} must report execution evidence, not drive workflow decisions`,
        );
      }
    }
  }
  const visited = new Set();
  const active = [];
  function visit(file) {
    if (active.includes(file)) {
      failures.push(
        `Dependency cycle: ${[...active.slice(active.indexOf(file)), file].join(" -> ")}`,
      );
      return;
    }
    if (visited.has(file)) return;
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return failures;
}
