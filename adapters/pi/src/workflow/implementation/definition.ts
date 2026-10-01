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
  id: "pi.implementation",
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
