import { demand, integer, keys, nonempty, text, texts } from "../contract-validation.js";
import { validateDag } from "../delivery/plan.js";
import { feedbackTargets } from "../policy.js";
import { object } from "../validation.js";
import type { Criterion, Document, PlannedAssignment, Story } from "./contract.js";

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
