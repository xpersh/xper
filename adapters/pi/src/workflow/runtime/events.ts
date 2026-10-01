import type { RecordedEvent } from "../../bridge/xper-client.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import type { implementationDefinition } from "../implementation/definition.js";
import type { knowledgeDefinition } from "../knowledge/definition.js";
import type { verificationDefinition } from "../verification/definition.js";

export function prepareRecordedEvents(
  state: AdapterCheckpoint,
  factsInput: Array<{ type: string; data: Record<string, unknown> }>,
  now: number,
  definition:
    | typeof knowledgeDefinition
    | typeof implementationDefinition
    | typeof verificationDefinition,
  context: { runId: string; instanceId: string },
  definitionsRecorded: Set<string>,
  id: () => string,
): RecordedEvent[] {
  function event(
    type: string,
    data: Record<string, unknown>,
    occurredAt: number,
    context: { runId: string; definition: { id: string; version: number }; instanceId: string },
  ): RecordedEvent {
    return {
      schemaVersion: 1,
      eventId: id(),
      runId: context.runId,
      occurredAt,
      type,
      data: {
        ...data,
        definitionId: context.definition.id,
        definitionVersion: context.definition.version,
        instanceId: context.instanceId,
      },
    };
  }
  const eventContext = {
    runId: context.runId,
    definition: { id: definition.id, version: definition.version },
    instanceId: context.instanceId,
  };
  const facts = factsInput.map((fact) => event(fact.type, fact.data, now, eventContext));
  const definitionKey = `${definition.id}@${definition.version}`;
  if (!definitionsRecorded.has(definitionKey)) {
    facts.unshift(event("workflow.definition", { definition }, now, eventContext));
    definitionsRecorded.add(definitionKey);
  }
  const content = JSON.stringify(state);
  let checkpoints: RecordedEvent[];
  if (Buffer.byteLength(content) < 28000)
    checkpoints = [
      event("adapter.state", { adapter: "pi", state: structuredClone(state) }, now, eventContext),
    ];
  else {
    const chunks: string[] = [];
    let chunk = "";
    let bytes = 0;
    for (const character of content) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + size > 24000) {
        chunks.push(chunk);
        chunk = "";
        bytes = 0;
      }
      chunk += character;
      bytes += size;
    }
    if (chunk) chunks.push(chunk);
    const checkpointId = id();
    checkpoints = chunks.map((content, index) =>
      event(
        "adapter.state.chunk",
        { adapter: "pi", checkpointId, index, count: chunks.length, content },
        now,
        eventContext,
      ),
    );
  }
  const events = [...facts, ...checkpoints];

  return events;
}
