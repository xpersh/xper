import type { ModelSelection } from "../types.js";
import { object } from "../validation.js";
import type { KnowledgeFeedbackReason } from "./contract.js";

export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text);

export const selection = (value: unknown): value is ModelSelection | null =>
  value === null ||
  (object(value) && [value.context, value.provider, value.model, value.thinking].every(text));

export const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);

export const relativePath = (value: unknown): value is string =>
  text(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.split(/[\\/]/).includes("..");

export const artifactPath = (value: unknown): value is string =>
  typeof value === "string" && /^\.xper\/artifacts\/[a-z0-9-]+\.(json|log)$/.test(value);

export const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const knowledgeFeedbackReason = (value: unknown): value is KnowledgeFeedbackReason =>
  value === "ambiguous_criteria" || value === "infeasible_design";
