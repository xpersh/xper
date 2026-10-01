import { WorkflowValidationError } from "./types.js";
/** Structural predicate shared by pure workflow contracts and checkpoint decoders. */
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

export const commit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
