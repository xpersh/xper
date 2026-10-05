import type { AvailableModel } from "../bridge/xper-client.js";
import type { RoleDescriptor } from "./roles.js";

export const INSPECTION_VERSION = 1;
export const MAX_INSPECTION_FRAME_BYTES = 1_048_576;

export type InspectionRequest = {
  schemaVersion: 1;
  id: string;
} & (
  | { method: "describe" | "models" | "refresh"; params?: Record<string, never> }
  | { method: "search"; params: { query: string; provider?: string } }
);

export type InspectionResult =
  | { adapter: "pi"; version: string; roles: RoleDescriptor[] }
  | { models: AvailableModel[] };

export type InspectionErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_METHOD"
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_TIMEOUT"
  | "CATALOG_INVALID"
  | "RESPONSE_TOO_LARGE";

export type InspectionResponse =
  | { schemaVersion: 1; id: string; result: InspectionResult }
  | {
      schemaVersion: 1;
      id: string | null;
      error: { code: InspectionErrorCode; message: string };
    };

export function failure(
  id: string | null,
  code: InspectionErrorCode,
  message: string,
): InspectionResponse {
  return { schemaVersion: 1, id, error: { code, message } };
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseRequest(value: unknown): InspectionRequest | InspectionResponse {
  const id =
    object(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    Buffer.byteLength(value.id) <= 256
      ? value.id
      : null;
  if (!object(value) || id === null)
    return failure(id, "INVALID_REQUEST", "A request requires a nonempty string ID");
  if (value.schemaVersion !== INSPECTION_VERSION)
    return failure(
      id,
      "UNSUPPORTED_VERSION",
      "Only adapter inspection schemaVersion 1 is supported",
    );
  if (!Object.keys(value).every((key) => ["schemaVersion", "id", "method", "params"].includes(key)))
    return failure(id, "INVALID_REQUEST", "Unexpected request fields");
  if (
    typeof value.method !== "string" ||
    !["describe", "models", "refresh", "search"].includes(value.method)
  )
    return failure(id, "UNKNOWN_METHOD", "Unknown inspection method");
  if (value.method === "search") {
    if (
      !object(value.params) ||
      !Object.keys(value.params).every((key) => ["query", "provider"].includes(key)) ||
      typeof value.params.query !== "string" ||
      (value.params.provider !== undefined &&
        (typeof value.params.provider !== "string" || !value.params.provider.trim()))
    )
      return failure(id, "INVALID_REQUEST", "Search requires a query and an optional provider");
  } else if (
    value.params !== undefined &&
    (!object(value.params) || Object.keys(value.params).length !== 0)
  ) {
    return failure(id, "INVALID_REQUEST", "This inspection method accepts no parameters");
  }
  return value as InspectionRequest;
}
