import { ProtocolFailure, errorCode } from "./protocol.js";

export interface ModelSelection {
  context: string;
  provider: string;
  model: string;
  thinking: string;
}

export interface RoutingSnapshot {
  profile: string;
  context: string;
  routes: Record<string, ModelSelection[]>;
}

export interface AvailableModel {
  provider: string;
  model: string;
  reasoning: boolean;
}

export interface RecordedEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  occurredAt: number;
  type: string;
  data: Record<string, unknown>;
}
export interface RecordedStatus {
  run: Record<string, unknown> | null;
  timeline: RecordedEvent[];
  durability: "persistent" | "volatile";
  degradedReason?: string | null;
  nextCursor?: string | null;
}
export interface RecorderClient {
  appendEvents(
    events: RecordedEvent[],
  ): Promise<{ accepted: number; durability: "persistent" | "volatile" }>;
  getRunStatus(runId?: string): Promise<RecordedStatus>;
  inspectProfile(): Promise<RoutingSnapshot | null>;
  resolveConfiguration(
    models?: AvailableModel[],
  ): Promise<{ routing: RoutingSnapshot | null; adapterConfig: Record<string, unknown> }>;
}
export interface RpcRequester {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function routingSnapshot(value: unknown): value is RoutingSnapshot {
  return (
    object(value) &&
    text(value.profile) &&
    text(value.context) &&
    object(value.routes) &&
    Object.values(value.routes).every(
      (items) =>
        Array.isArray(items) &&
        items.length > 0 &&
        items.every(
          (item) =>
            object(item) &&
            text(item.context) &&
            text(item.provider) &&
            text(item.model) &&
            text(item.thinking),
        ),
    )
  );
}
export function recordedEvent(value: unknown): value is RecordedEvent {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    text(value.eventId) &&
    text(value.runId) &&
    Number.isSafeInteger(value.occurredAt) &&
    Number(value.occurredAt) >= 0 &&
    text(value.type) &&
    object(value.data)
  );
}
function durability(value: unknown): value is "persistent" | "volatile" {
  return value === "persistent" || value === "volatile";
}
/** Configuration and passive recording only; execution policy belongs to Pi. */
export class XperClient implements RecorderClient {
  constructor(private readonly rpc: RpcRequester) {}
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<T> {
    const result = await this.rpc.request(method, params);
    if (!valid(result))
      throw new ProtocolFailure(errorCode.invalidRequest, `invalid ${method} result`);
    return result;
  }
  appendEvents(events: RecordedEvent[]) {
    return this.call(
      "event.append",
      { events },
      (value): value is { accepted: number; durability: "persistent" | "volatile" } =>
        object(value) &&
        Number.isSafeInteger(value.accepted) &&
        Number(value.accepted) >= 0 &&
        Number(value.accepted) <= events.length &&
        durability(value.durability),
    );
  }
  async getRunStatus(runId?: string): Promise<RecordedStatus> {
    const timeline: RecordedEvent[] = [];
    let after: string | undefined;
    let selectedRun = runId;
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.call(
        "run.status",
        { ...(selectedRun ? { runId: selectedRun } : {}), ...(after ? { after } : {}) },
        (value): value is RecordedStatus =>
          object(value) &&
          (value.run === null || object(value.run)) &&
          Array.isArray(value.timeline) &&
          value.timeline.every(recordedEvent) &&
          durability(value.durability) &&
          (value.degradedReason === undefined ||
            value.degradedReason === null ||
            typeof value.degradedReason === "string") &&
          (value.nextCursor === undefined || value.nextCursor === null || text(value.nextCursor)),
      );
      if (!selectedRun && typeof page.run?.runId === "string") selectedRun = page.run.runId;
      timeline.push(...page.timeline);
      if (!page.nextCursor) return { ...page, timeline };
      if (cursors.has(page.nextCursor) || page.timeline.at(-1)?.eventId !== page.nextCursor)
        throw new ProtocolFailure(errorCode.invalidRequest, "invalid run.status pagination");
      cursors.add(page.nextCursor);
      after = page.nextCursor;
    }
  }
  async inspectProfile(): Promise<RoutingSnapshot | null> {
    const value = await this.call(
      "profile.inspect",
      {},
      (value): value is { routing: RoutingSnapshot | null } =>
        object(value) && (value.routing === null || routingSnapshot(value.routing)),
    );
    return value.routing;
  }
  resolveConfiguration(models?: AvailableModel[]) {
    return this.call(
      "configuration.resolve",
      models ? { models } : {},
      (
        value,
      ): value is { routing: RoutingSnapshot | null; adapterConfig: Record<string, unknown> } =>
        object(value) &&
        (value.routing === null || routingSnapshot(value.routing)) &&
        object(value.adapterConfig),
    );
  }
}
