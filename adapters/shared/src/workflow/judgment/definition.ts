import { definitionFamily, isDefinition, type DefinitionIdentity } from "../definition-identity.js";
import { invalid } from "../validation.js";
import { defineWorkflow } from "../graph.js";
export const judgmentDefinition = defineWorkflow({
  schemaVersion: 1,
  id: "xper.judgment",
  version: 1,
  initial: "judge",
  nodes: [
    {
      id: "judge",
      label: "Evaluate verified work",
      kind: "activity",
      role: "judgment_day.judge",
      artifactKind: "judgment_verdict",
    },
    { id: "reported", label: "Recommendation recorded", kind: "terminal" },
  ],
  edges: [
    {
      id: "judgment.reported",
      from: "judge",
      to: "reported",
      event: "judgment.reported",
      kind: "completion",
      guards: [
        "The report references the frozen evaluated evidence",
        "Every criterion has an independent finding",
      ],
    },
  ],
});

export const legacyJudgmentDefinition = defineWorkflow({
  ...judgmentDefinition,
  id: "pi.judgment",
});
export function definitionForJudgment(identity: DefinitionIdentity) {
  if (!isDefinition(identity, "judgment", [1])) invalid("unsupported judgment definition");
  return definitionFamily(identity.id) === "pi" ? legacyJudgmentDefinition : judgmentDefinition;
}
