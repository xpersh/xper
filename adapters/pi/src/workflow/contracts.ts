import { object } from "../bridge/xper-client.js";
import { feedbackTargets } from "./policy.js";
import type { RemainingBudget } from "./types.js";

export interface Criterion {
  id: string;
  behavior: string;
  example: string;
}
export interface Story {
  id: string;
  value: string;
  criteria: string[];
  verification: string[];
  independentlyVerifiable: boolean;
  dependencies: string[];
}
export interface PlannedAssignment {
  id: string;
  incrementId: string;
  role: string;
  dependencies: string[];
  workspace: string;
  resources: string[];
  maxAttempts: number;
  maxTimeMs: number;
  maxCostMicros: number;
}
export type Output =
  | {
      kind: "definition_contract";
      goal: string;
      scope: string[];
      exclusions: string[];
      criteria: Criterion[];
    }
  | {
      kind: "design_decisions";
      approach: string;
      interfaces: string[];
      alternatives: string[];
      risks: string[];
      feasible: boolean;
    }
  | { kind: "story_map"; stories: Story[] }
  | { kind: "execution_plan"; assignments: PlannedAssignment[] }
  | { kind: "feedback"; reason: string; evidence: string };
export interface Document {
  schemaVersion: 1;
  inputs: string[];
  output: Output;
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const nonempty = (value: unknown): value is string[] => texts(value) && value.length > 0;
const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function demand(
  value: unknown,
  message = "artifact does not satisfy its minimum phase contract",
): asserts value {
  if (!value) throw new Error(message);
}
interface Node {
  id: string;
  dependencies: string[];
  workspace?: string;
  resources?: string[];
}
export function validateDag(nodes: Node[]): Map<string, Set<string>> {
  demand(
    nodes.length > 0 && nodes.every((n) => text(n.id)),
    "a nonempty DAG with named nodes is required",
  );
  const index = new Map(nodes.map((n) => [n.id, n]));
  demand(index.size === nodes.length, "duplicate DAG node");
  for (const node of nodes)
    demand(
      new Set(node.dependencies).size === node.dependencies.length &&
        node.dependencies.every((d) => d !== node.id && index.has(d)),
      "unknown, duplicate, or self dependency",
    );
  const ancestors = new Map<string, Set<string>>();
  while (ancestors.size < nodes.length) {
    const node = nodes.find(
      (n) => !ancestors.has(n.id) && n.dependencies.every((d) => ancestors.has(d)),
    );
    demand(node, "dependency cycle");
    ancestors.set(
      node.id,
      new Set(node.dependencies.flatMap((d) => [d, ...(ancestors.get(d) ?? [])])),
    );
  }
  for (const [i, a] of nodes.entries())
    for (const b of nodes.slice(i + 1)) {
      const conflict =
        (a.workspace && a.workspace === b.workspace) ||
        a.resources?.some((r) => b.resources?.includes(r));
      demand(
        !conflict || ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id),
        "unordered assignments have a workspace or resource conflict",
      );
    }
  return ancestors;
}
export function parseDocument(content: string, expectedInputs: string[]): Document {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    throw new Error("structured phase artifact required");
  }
  demand(
    object(document) &&
      keys(document, ["schemaVersion", "inputs", "output"]) &&
      document.schemaVersion === 1 &&
      texts(document.inputs) &&
      object(document.output),
    "structured phase artifact required",
  );
  demand(
    new Set(document.inputs).size === document.inputs.length &&
      [...document.inputs].sort().join("\n") === [...expectedInputs].sort().join("\n"),
    "artifact version or input references do not match the assignment contract",
  );
  const out = document.output;
  switch (out.kind) {
    case "definition_contract":
      demand(
        keys(out, ["kind", "goal", "scope", "exclusions", "criteria"]) &&
          text(out.goal) &&
          nonempty(out.scope) &&
          texts(out.exclusions) &&
          Array.isArray(out.criteria) &&
          out.criteria.length > 0,
      );
      demand(
        out.criteria.every(
          (c) =>
            object(c) &&
            keys(c, ["id", "behavior", "example"]) &&
            text(c.id) &&
            text(c.behavior) &&
            text(c.example),
        ),
      );
      demand(new Set(out.criteria.map((c) => (c as Criterion).id)).size === out.criteria.length);
      break;
    case "design_decisions":
      demand(
        keys(out, ["kind", "approach", "interfaces", "alternatives", "risks", "feasible"]) &&
          text(out.approach) &&
          nonempty(out.interfaces) &&
          nonempty(out.alternatives) &&
          texts(out.risks) &&
          typeof out.feasible === "boolean",
      );
      break;
    case "story_map": {
      demand(keys(out, ["kind", "stories"]) && Array.isArray(out.stories));
      demand(
        out.stories.every(
          (s) =>
            object(s) &&
            keys(s, [
              "id",
              "value",
              "criteria",
              "verification",
              "independentlyVerifiable",
              "dependencies",
            ]) &&
            text(s.id) &&
            text(s.value) &&
            nonempty(s.criteria) &&
            nonempty(s.verification) &&
            s.independentlyVerifiable === true &&
            texts(s.dependencies),
        ),
        "each story must deliver value and be independently verifiable against criteria",
      );
      validateDag(out.stories as Story[]);
      break;
    }
    case "execution_plan": {
      demand(keys(out, ["kind", "assignments"]) && Array.isArray(out.assignments));
      demand(
        out.assignments.every(
          (a) =>
            object(a) &&
            keys(a, [
              "id",
              "incrementId",
              "role",
              "dependencies",
              "workspace",
              "resources",
              "maxAttempts",
              "maxTimeMs",
              "maxCostMicros",
            ]) &&
            text(a.id) &&
            text(a.incrementId) &&
            ["implementation.driver", "verify.verifier"].includes(String(a.role)) &&
            texts(a.dependencies) &&
            text(a.workspace) &&
            /^[a-zA-Z0-9_-]+$/.test(a.workspace) &&
            texts(a.resources) &&
            integer(a.maxAttempts, 1) &&
            integer(a.maxTimeMs, 1) &&
            integer(a.maxCostMicros),
        ),
        "plan assignments need an increment, delivery role, workspace identifier, and positive budgets",
      );
      validateDag(out.assignments as PlannedAssignment[]);
      break;
    }
    case "feedback":
      demand(
        keys(out, ["kind", "reason", "evidence"]) &&
          typeof out.reason === "string" &&
          Object.hasOwn(feedbackTargets, out.reason) &&
          text(out.evidence),
      );
      break;
    default:
      throw new Error("unknown phase artifact kind");
  }
  return document as unknown as Document;
}
export function validateLinks(
  output: Output,
  upstream: Partial<Record<string, Document>>,
  budget: RemainingBudget,
): void {
  if (output.kind === "story_map") {
    const definition = upstream.define?.output;
    demand(
      definition?.kind === "definition_contract",
      "required upstream artifact has not passed its gate",
    );
    const known = new Set(definition.criteria.map((c) => c.id));
    const covered = new Set(output.stories.flatMap((s) => s.criteria));
    demand(
      known.size === covered.size && [...known].every((id) => covered.has(id)),
      "stories must cover every defined criterion without unknown criteria",
    );
  }
  if (output.kind !== "execution_plan") return;
  const map = upstream.breakdown?.output;
  demand(map?.kind === "story_map", "required upstream artifact has not passed its gate");
  const assignments = output.assignments;
  demand(
    assignments.every((a) => map.stories.some((s) => s.id === a.incrementId)),
    "plan references an unknown increment",
  );
  const ancestors = validateDag(assignments);
  for (const story of map.stories) {
    const group = assignments.filter((a) => a.incrementId === story.id);
    for (const role of ["implementation.driver", "verify.verifier"])
      demand(
        group.filter((a) => a.role === role).length === 1,
        "each increment needs one implementer and one independent verifier",
      );
    for (const assignment of group) {
      for (const dependency of story.dependencies) {
        const verifier = assignments.find(
          (a) => a.incrementId === dependency && a.role === "verify.verifier",
        );
        demand(
          verifier && ancestors.get(assignment.id)?.has(verifier.id),
          "assignment DAG omits an increment dependency",
        );
      }
      if (assignment.role === "verify.verifier")
        demand(
          group
            .filter((a) => a.role !== "verify.verifier")
            .every((a) => ancestors.get(assignment.id)?.has(a.id)),
          "verification must depend on its implementer",
        );
    }
  }
  const sum = (key: "maxAttempts" | "maxTimeMs" | "maxCostMicros") =>
    assignments.reduce((total, a) => total + a[key], 0);
  demand(
    sum("maxAttempts") <= budget.attempts &&
      sum("maxTimeMs") <= budget.timeMs &&
      (budget.costMicros === null || sum("maxCostMicros") <= budget.costMicros),
    "execution plan exceeds remaining run budgets",
  );
}
