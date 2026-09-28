import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode, ProtocolFailure } from "../bridge/protocol.js";
import type { RecordedEvent } from "../bridge/xper-client.js";
import { type JournalData, WorkflowJournal } from "../workflow/journal.js";

function event(id: string, data: Record<string, unknown> = {}): RecordedEvent {
  return { schemaVersion: 1, eventId: id, runId: "run", occurredAt: 1, type: "test.fact", data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function beforeTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(2_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("local operation waited for recording I/O");
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

async function snapshot(journal: WorkflowJournal): Promise<JournalData> {
  return JSON.parse(await readFile(journal.path, "utf8")) as JournalData;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("background delivery did not finish");
    await delay(10);
  }
}

test("pending RPCs never delay local commits and concurrent saves preserve the latest state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-concurrency-"));
  const started = deferred<void>();
  const release = deferred<void>();
  let active = 0;
  let maximum = 0;
  const received: string[] = [];
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      active++;
      maximum = Math.max(maximum, active);
      if (received.length === 0) {
        started.resolve();
        await release.promise;
      }
      received.push(...events.map((event) => event.eventId));
      active--;
      return { accepted: events.length, durability: "persistent" };
    },
  });
  try {
    await beforeTimeout(journal.commit({ revision: 1 }, [event("first")]));
    await started.promise;
    await beforeTimeout(
      Promise.all([
        journal.commit({ revision: 2 }, [event("second")]),
        journal.commit({ revision: 3 }, [event("third")]),
      ]),
    );
    const saved = await snapshot(journal);
    assert.deepEqual(saved.state, { revision: 3 });
    assert.deepEqual(
      saved.pending.map((event) => event.eventId),
      ["first", "second", "third"],
    );
    assert.equal(received.length, 0);
    assert.match(journal.problem ?? "", /3 recording event\(s\) pending in the local outbox/);
    release.resolve();
    await journal.waitForIdle();
    assert.equal(maximum, 1);
    assert.deepEqual(received, ["first", "second", "third"]);
    assert.deepEqual((await snapshot(journal)).state, { revision: 3 });
    assert.deepEqual((await snapshot(journal)).pending, []);
  } finally {
    release.resolve();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery starts after the local commit returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-scheduling-"));
  let called = false;
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      called = true;
      return { accepted: events.length, durability: "persistent" };
    },
  });
  try {
    await journal.commit({}, [event("one")]);
    assert.equal(called, false);
    await journal.waitForIdle();
    assert.equal(called, true);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("volatile acknowledgements retain identical facts across journal recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-volatile-"));
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      return { accepted: events.length, durability: "volatile" };
    },
  });
  const facts = [event("one", { observation: true })];
  let restored: WorkflowJournal | undefined;
  try {
    await journal.commit({ revision: 1 }, facts);
    await journal.waitForIdle();
    assert.deepEqual(journal.pending, facts);
    assert.match(journal.problem ?? "", /volatile/);
    await journal.close();
    const received: RecordedEvent[] = [];
    restored = new WorkflowJournal(directory, "session", {
      async appendEvents(events) {
        received.push(...events);
        return { accepted: events.length, durability: "persistent" };
      },
    });
    await restored.load();
    restored.flush();
    await restored.waitForIdle();
    assert.deepEqual(received, facts);
    assert.deepEqual(restored.pending, []);
  } finally {
    await journal.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("transient delivery failures retry with stable IDs after bounded backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-retry-"));
  const deliveries: string[][] = [];
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      deliveries.push(events.map((event) => event.eventId));
      if (deliveries.length === 1) throw new Error("connection lost after remote append");
      return { accepted: 0, durability: "persistent" };
    },
  });
  try {
    await journal.commit({}, [event("stable")]);
    await journal.waitForIdle();
    assert.equal(deliveries.length, 1);
    assert.match(journal.problem ?? "", /unavailable/);
    await delay(30);
    assert.equal(deliveries.length, 1);
    await until(() => journal.pending.length === 0);
    await journal.waitForIdle();
    assert.deepEqual(deliveries, [["stable"], ["stable"]]);
    assert.equal(journal.problem, undefined);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("permanent batch rejection isolates the bad fact and allows later facts to reach Xper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-rejected-"));
  const received: string[] = [];
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      if (events.some((event) => event.eventId === "conflict"))
        throw new ProtocolFailure(errorCode.invalidParams, "event ID has conflicting content");
      received.push(...events.map((event) => event.eventId));
      return { accepted: events.length, durability: "persistent" };
    },
  });
  const bad = event("conflict", { preserve: "the complete rejected fact" });
  let restored: WorkflowJournal | undefined;
  try {
    await journal.commit({}, [event("before"), bad, event("after")]);
    await journal.waitForIdle();
    assert.deepEqual(received, ["before", "after"]);
    assert.deepEqual(journal.pending, []);
    assert.deepEqual(journal.rejected, [
      { event: bad, reason: "event ID has conflicting content", code: errorCode.invalidParams },
    ]);
    assert.match(
      journal.problem ?? "",
      /1 recording event\(s\) rejected; retained in the local journal/,
    );
    await journal.close();
    restored = new WorkflowJournal(directory, "session", {
      async appendEvents() {
        throw new Error("rejected facts must not be retried automatically");
      },
    });
    await restored.load();
    assert.deepEqual(restored.rejected, journal.rejected);
    assert.match(restored.problem ?? "", /rejected/);
  } finally {
    await journal.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an event between 40 KiB and 48 kB is retained without poisoning later delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-size-"));
  const received: RecordedEvent[] = [];
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      received.push(...events);
      return { accepted: events.length, durability: "persistent" };
    },
  });
  const large = event("large", { routing: "x".repeat(42_000) });
  const good = event("after");
  try {
    await journal.commit({}, [large, good]);
    await journal.waitForIdle();
    assert.deepEqual(received, [good]);
    assert.deepEqual(journal.rejected[0]?.event, large);
    assert.match(journal.rejected[0]?.reason ?? "", /40 KiB/);
    assert.deepEqual((await snapshot(journal)).rejected?.[0]?.event, large);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery batches stay inside JSON-RPC limits and contain one run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-batches-"));
  const batches: RecordedEvent[][] = [];
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      batches.push(events);
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id: "adapter-12345",
        method: "event.append",
        params: { events },
      });
      assert(Buffer.byteLength(frame) <= 65_536);
      assert(events.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 40 * 1024));
      assert.equal(new Set(events.map((event) => event.runId)).size, 1);
      return { accepted: events.length, durability: "persistent" };
    },
  });
  const facts = [
    event("one", { value: "a".repeat(25_000) }),
    event("two", { value: "b".repeat(25_000) }),
    { ...event("three"), runId: "other-run" },
  ];
  try {
    await journal.commit({}, facts);
    await journal.waitForIdle();
    assert.deepEqual(batches.flat(), facts);
    assert.equal(batches.length, 3);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing never waits for remote I/O and late acknowledgements cannot recreate journal files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-close-"));
  const started = deferred<void>();
  const release = deferred<void>();
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents(events) {
      started.resolve();
      await release.promise;
      return { accepted: events.length, durability: "persistent" };
    },
  });
  await journal.commit({}, [event("pending")]);
  await started.promise;
  await beforeTimeout(journal.close());
  assert.equal((await snapshot(journal)).pending.length, 1);
  await rm(directory, { recursive: true, force: true });
  release.resolve();
  await journal.waitForIdle();
  await assert.rejects(access(directory));
});

test("reconnecting kicks retained delivery without changing the local checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xper-journal-reconnect-"));
  const journal = new WorkflowJournal(directory, "session", {
    async appendEvents() {
      throw new Error("offline");
    },
  });
  const received: RecordedEvent[] = [];
  try {
    await journal.commit({ revision: 7 }, [event("pending")]);
    await journal.waitForIdle();
    journal.setRecorder({
      async appendEvents(events) {
        received.push(...events);
        return { accepted: events.length, durability: "persistent" };
      },
    });
    await journal.waitForIdle();
    assert.equal(received.length, 1);
    assert.deepEqual(journal.state, { revision: 7 });
    assert.deepEqual((await snapshot(journal)).pending, []);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
