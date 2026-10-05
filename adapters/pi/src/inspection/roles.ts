import type { WorkflowDefinition } from "../workflow/graph.js";
import { implementationReworkDefinition } from "../workflow/implementation/definition.js";
import { judgmentDefinition } from "../workflow/judgment/definition.js";
import { knowledgeDefinition } from "../workflow/knowledge/definition.js";
import { verificationDefinition } from "../workflow/verification/definition.js";

export interface RoleDescriptor {
  id: string;
  label: string;
  guidance: string;
}

// Advice follows RFC 0002. It never restricts a model or changes execution policy.
const guidance: Record<string, string> = {
  "discovery.explorer": "A fast, inexpensive model is usually sufficient for gathering context.",
  "define.product": "Prefer strong product reasoning for goals, scope, and acceptance criteria.",
  "design.designer": "Consider a frontier model for architecture decisions and risky changes.",
  "breakdown.slicer":
    "A balanced model is usually sufficient for splitting work into verifiable increments.",
  "plan.planner": "A balanced model with reliable structured output suits dependency planning.",
  "implementation.driver":
    "A capable local or inexpensive coding model may suit well-defined increments.",
  "verify.verifier":
    "Prefer independent review; choosing a different model can provide another perspective.",
  "judgment_day.judge":
    "Prefer your most reliable model; consider a frontier model for the final assessment.",
};

export function describeRoles(): RoleDescriptor[] {
  const definitions: WorkflowDefinition[] = [
    knowledgeDefinition,
    implementationReworkDefinition,
    verificationDefinition,
    judgmentDefinition,
  ];
  return definitions.flatMap((definition) =>
    definition.nodes.flatMap((node) => {
      if (!node.role) return [];
      const help = guidance[node.role];
      if (!help) throw new Error("A declared Pi role is missing configuration guidance");
      return [{ id: node.role, label: node.label, guidance: help }];
    }),
  );
}
