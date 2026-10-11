import { isBuiltin } from "node:module";
import { posix } from "node:path";
import ts from "typescript";

export function isPureWorkflow(file) {
  return (
    file.startsWith("workflow/") &&
    !file.startsWith("workflow/runtime/") &&
    !["workflow/controller.ts", "workflow/journal.ts"].includes(file)
  );
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

function isPureModule(file) {
  return ["index.ts", "roles.ts", "role-descriptions.ts"].includes(file) || isPureWorkflow(file);
}

function isHarnessDependency(specifier) {
  return (
    /^@(?:earendil-works|mariozechner)\/pi(?:-|$)/.test(specifier) ||
    /^@opencode-ai\//.test(specifier) ||
    /^(?:pi-coding-agent|opencode-ai)(?:\/|$)/.test(specifier) ||
    /^@xper\/adapter-/.test(specifier)
  );
}

export function checkDependencies(dependencies) {
  return dependencies.flatMap((dependency) => {
    if (isHarnessDependency(dependency))
      return [`Shared adapters must not depend on a concrete harness: ${dependency}`];
    if (dependency.startsWith("@xper/") && dependency !== "@xper/protocol")
      return [`Shared adapters depend on private xper package ${dependency}`];
    return [];
  });
}

export function checkArchitecture(sources) {
  const failures = [];
  const graph = new Map();
  for (const [adapterPath, source] of sources) {
    if (adapterPath.startsWith("__tests__/")) continue;
    const pureWorkflow = isPureModule(adapterPath);
    const imports = moduleImports(adapterPath, source);
    graph.set(
      adapterPath,
      imports.map((edge) => edge.target).filter((target) => sources.has(target)),
    );
    if (
      pureWorkflow &&
      /\b(?:Date\s*\.\s*now|Math\s*\.\s*random|randomUUID|fetch|setTimeout|setInterval|setImmediate)\s*\(|\bnew\s+Date\s*\(\s*\)|\b(?:process|globalThis\s*\.\s*crypto)\s*\./.test(
        source,
      )
    ) {
      failures.push(`${adapterPath} must receive time, identities, and effects as explicit inputs`);
    }
    if (
      (adapterPath === "workflow/controller.ts" || adapterPath.startsWith("workflow/runtime/")) &&
      /\bphases\s*(?:\[|\.\s*(?:indexOf|slice|at|find|findIndex)\s*\()/.test(source)
    ) {
      failures.push(
        `${adapterPath} must delegate phase navigation to the explicit workflow machine`,
      );
    }
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
      ((adapterPath.startsWith("bridge/") &&
        /["'](?:run\.start|run\.advance|assignment\.start|attempt\.finish)["']/.test(source)) ||
        /\.(?:request|call)\s*(?:<[^>]+>)?\s*\(\s*["'](?:run\.start|run\.advance|assignment\.start|attempt\.finish)["']/.test(
          source,
        ))
    ) {
      failures.push(
        `${adapterPath} must keep workflow commands inside adapters, not in RPC messages`,
      );
    }
    if (
      adapterPath.startsWith("workflow/") &&
      adapterPath !== "workflow/journal.ts" &&
      /\.(?:appendEvents|resolveConfiguration|inspectProfile|getRunStatus|request)\s*\(/.test(
        source,
      )
    ) {
      failures.push(
        `${adapterPath} must use local execution state and prepared configuration; only the journal delivers telemetry`,
      );
    }
    if (
      (adapterPath === "actions.ts" || adapterPath.startsWith("actions/")) &&
      /await\s+[^;\n]*(?:recordUsage|waitForRecording|waitForIdle)\s*(?:\?\.)?\(/.test(source)
    ) {
      failures.push(`${adapterPath} must not await telemetry delivery`);
    }
    for (const { specifier, typeOnly, target } of imports) {
      if (isHarnessDependency(specifier) || target?.startsWith("../")) {
        failures.push(
          `${adapterPath} must not depend on a concrete adapter or harness (${specifier})`,
        );
      }
      if (
        adapterPath.startsWith("workflow/") &&
        (specifier?.endsWith("/bridge/client.js") || (target === "bridge.ts" && !typeOnly))
      ) {
        failures.push(`${adapterPath} must not depend on the bridge process`);
      }
      if (isPureWorkflow(adapterPath) && !typeOnly && target && !target.startsWith("workflow/")) {
        failures.push(
          `${adapterPath} must import pure workflow modules directly, without public metadata barrels`,
        );
      }
      if (
        (adapterPath === "bridge.ts" || adapterPath.startsWith("bridge/")) &&
        (target === "index.ts" ||
          target === "role-descriptions.ts" ||
          target === "workflow.ts" ||
          target?.startsWith("workflow/"))
      ) {
        failures.push(`${adapterPath} must not depend on workflow policy`);
      }
      if (pureWorkflow && !typeOnly && (isBuiltin(specifier) || !isPureModule(target ?? ""))) {
        failures.push(
          `${adapterPath} must remain pure and independent of execution, storage, and transport (${specifier})`,
        );
      }
      if (
        (adapterPath === "actions.ts" || adapterPath.startsWith("actions/")) &&
        !typeOnly &&
        !target?.startsWith("actions/") &&
        !isPureWorkflow(target ?? "")
      ) {
        failures.push(
          `${adapterPath} must receive harness execution and I/O through its dependencies`,
        );
      }
      if (
        adapterPath.startsWith("workflow/runtime/") &&
        !typeOnly &&
        specifier !== "node:buffer" &&
        !target?.startsWith("workflow/runtime/") &&
        !isPureWorkflow(target ?? "")
      ) {
        failures.push(`${adapterPath} must receive local effects through its runtime ports`);
      }
      if (
        (adapterPath === "execution.ts" || adapterPath.startsWith("execution/")) &&
        !typeOnly &&
        (target === "index.ts" ||
          target === "role-descriptions.ts" ||
          target === "workflow.ts" ||
          target?.startsWith("workflow/"))
      ) {
        failures.push(
          `${adapterPath} must report execution evidence, not drive workflow decisions`,
        );
      }
      const owner = adapterPath.match(
        /^workflow\/(knowledge|implementation|verification|judgment)\//,
      )?.[1];
      const dependencyOwner = target?.match(
        /^workflow\/(knowledge|implementation|verification|judgment)\//,
      )?.[1];
      if (
        owner &&
        dependencyOwner &&
        owner !== dependencyOwner &&
        !(typeOnly && target.endsWith("/contract.ts"))
      ) {
        failures.push(
          `${adapterPath} must compose other flows through delivery, not import ${target}`,
        );
      }
      const importsPrivateXperPackage =
        specifier?.startsWith("@xper/") && specifier !== "@xper/protocol";
      if (
        specifier?.includes("/crates/") ||
        /^xper-(?!protocol(?:$|\/))/.test(specifier ?? "") ||
        importsPrivateXperPackage
      ) {
        failures.push(`${adapterPath} imports private core module ${specifier}`);
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
