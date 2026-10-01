import { defineWorkflow } from "../graph.js";

export const verificationNodes = [
  {
    id: "verify",
    label: "Verify increment",
    kind: "activity",
    role: "verify.verifier",
    artifactKind: "verification_result",
  },
  { id: "verified", label: "Increment verified", kind: "terminal" },
  { id: "rejected", label: "Increment rejected", kind: "terminal" },
] as const;

export type VerificationNodeId = (typeof verificationNodes)[number]["id"];

export const verificationDefinition = defineWorkflow<VerificationNodeId>({
  schemaVersion: 1,
  id: "pi.verification",
  version: 1,
  initial: "verify",
  nodes: verificationNodes,
  edges: [
    {
      id: "verification.accepted",
      from: "verify",
      to: "verified",
      event: "gate.passed",
      kind: "completion",
      guards: [
        "The report evaluates the exact registered implementation revision",
        "Every criterion and review dimension has passing evidence",
        "Every host-run test passed without changing evaluated source",
      ],
    },
    {
      id: "verification.rejected",
      from: "verify",
      to: "rejected",
      event: "gate.rejected",
      kind: "completion",
      guards: [
        "The report evaluates the exact registered implementation revision",
        "The rejection identifies a concrete cause and evidence",
        "Host-run evidence remains bound to unchanged evaluated source",
      ],
    },
  ],
});
