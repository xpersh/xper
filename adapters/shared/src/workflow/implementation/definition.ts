import { definitionFamily, isDefinition, type DefinitionIdentity } from "../definition-identity.js";
import { invalid } from "../validation.js";
import { defineWorkflow } from "../graph.js";

export const implementationNodes = [
  {
    id: "implement",
    label: "Implement increment",
    kind: "activity",
    role: "implementation.driver",
    artifactKind: "implementation_result",
  },
  { id: "implemented", label: "Increment implemented", kind: "terminal" },
] as const;

export type ImplementationNodeId = (typeof implementationNodes)[number]["id"];

export const implementationDefinition = defineWorkflow<ImplementationNodeId>({
  schemaVersion: 1,
  id: "xper.implementation",
  version: 1,
  initial: "implement",
  nodes: implementationNodes,
  edges: [
    {
      id: "implementation.accepted",
      from: "implement",
      to: "implemented",
      event: "gate.passed",
      kind: "completion",
      guards: [
        "The Implementer committed a change descended from the recorded base",
        "The checkout is clean and every host-run test passed",
        "Every increment criterion has concrete evidence",
      ],
    },
  ],
});

export const implementationReworkDefinition = defineWorkflow<ImplementationNodeId>({
  ...implementationDefinition,
  version: 2,
  edges: implementationDefinition.edges.map((edge) => ({
    ...edge,
    guards: [
      "The result is a descendant change or an unchanged revision authorized by the applied Judge report",
      "The checkout is clean and every host-run test passed",
      "Every increment criterion has concrete evidence",
    ],
  })),
});
export const legacyImplementationDefinition = defineWorkflow({
  ...implementationDefinition,
  id: "pi.implementation",
});
export const legacyImplementationReworkDefinition = defineWorkflow({
  ...implementationReworkDefinition,
  id: "pi.implementation",
});
export function definitionForImplementation(identity: DefinitionIdentity) {
  if (!isDefinition(identity, "implementation", [1, 2]))
    invalid("unsupported implementation definition");
  if (definitionFamily(identity.id) === "pi")
    return identity.version === 2
      ? legacyImplementationReworkDefinition
      : legacyImplementationDefinition;
  return identity.version === 2 ? implementationReworkDefinition : implementationDefinition;
}
