import type { ModelUsage } from "./types.js";
export function usageData(attemptId: string, usage: ModelUsage): Record<string, unknown> {
  const data: Record<string, unknown> = { attemptId };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "costMicros",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const value = usage[key];
    if (value === null || (Number.isSafeInteger(value) && Number(value) >= 0)) data[key] = value;
  }
  if (usage.provider) data.provider = usage.provider;
  if (usage.model) data.model = usage.model;
  if (usage.costSource) data.costSource = usage.costSource;
  return data;
}
