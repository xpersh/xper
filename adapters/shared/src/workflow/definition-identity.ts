import { invalid, object } from "./validation.js";

export type DefinitionFamily = "pi" | "xper";
export type WorkflowKind = "knowledge" | "implementation" | "verification" | "judgment";
export interface DefinitionIdentity {
  id: string;
  version: number;
}

export function definitionId(family: DefinitionFamily, kind: WorkflowKind): string {
  if (family !== "pi" && family !== "xper") invalid("unsupported workflow definition family");
  return `${family}.${kind}`;
}

export function definitionFamily(id: string): DefinitionFamily {
  switch (id) {
    case "pi.knowledge":
    case "pi.implementation":
    case "pi.verification":
    case "pi.judgment":
      return "pi";
    case "xper.knowledge":
    case "xper.implementation":
    case "xper.verification":
    case "xper.judgment":
      return "xper";
    default:
      return invalid("unsupported workflow definition family");
  }
}

export function isDefinition(
  value: unknown,
  kind: WorkflowKind,
  versions: readonly number[],
): value is DefinitionIdentity {
  return (
    object(value) &&
    (value.id === definitionId("pi", kind) || value.id === definitionId("xper", kind)) &&
    typeof value.version === "number" &&
    versions.includes(value.version)
  );
}
