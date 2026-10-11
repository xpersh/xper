/** Pure workflow contracts and role metadata; importing this entry starts no runtime. */
export * from "./workflow/types.js";
export type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from "./workflow/graph.js";
export { knowledgeDefinition } from "./workflow/knowledge/definition.js";
export {
  implementationDefinition,
  implementationReworkDefinition,
} from "./workflow/implementation/definition.js";
export { verificationDefinition } from "./workflow/verification/definition.js";
export { judgmentDefinition } from "./workflow/judgment/definition.js";
export type { JudgmentReport } from "./workflow/judgment/contract.js";
export { capabilitiesForRole, resolveAgent } from "./roles.js";
export type { RoleCapability } from "./roles.js";
export { describeRoles } from "./role-descriptions.js";
export type { RoleDescriptor } from "./role-descriptions.js";
