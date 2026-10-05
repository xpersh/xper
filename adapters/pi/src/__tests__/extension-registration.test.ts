import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createXperExtension } from "../extension.js";
import type { PiExtensionAPI } from "../pi/types.js";

type Events = NonNullable<PiExtensionAPI["events"]>;

function eventBus(): Events {
  const emitter = new EventEmitter();
  return {
    emit: (channel, data) => {
      emitter.emit(channel, data);
    },
    on: (channel, handler) => {
      // Pi wraps handlers in an async function, but invokes their body before awaiting.
      const safeHandler = async (data: unknown) => {
        await handler(data);
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
  };
}

function runtime(bus = eventBus()) {
  const subscriptions = new Set<() => void>();
  const events: Events = {
    emit: bus.emit,
    on: (channel, handler) => {
      const unsubscribe = bus.on(channel, handler);
      const release = () => {
        subscriptions.delete(release);
        unsubscribe();
      };
      subscriptions.add(release);
      return release;
    },
  };
  return {
    events,
    subscriptions,
    invalidate: () => {
      for (const release of subscriptions) release();
    },
  };
}

function extensionApi(events?: Events, failure?: "command" | "tool" | "hook") {
  const commands: string[] = [];
  const tools: string[] = [];
  const hooks: string[] = [];
  const pi: PiExtensionAPI = {
    ...(events ? { events } : {}),
    registerCommand: (name) => {
      if (failure === "command") throw new Error("command registration failed");
      commands.push(name);
    },
    registerTool: (tool) => {
      if (failure === "tool") throw new Error("tool registration failed");
      tools.push(tool.name);
    },
    on: (event) => {
      if (failure === "hook") throw new Error("hook registration failed");
      hooks.push(event);
    },
  };
  return { pi, commands, tools, hooks };
}

test("the first global or project factory registers once before the next microtask", () => {
  const host = runtime();
  const first = extensionApi(host.events);
  const second = extensionApi(host.events);
  const third = extensionApi(host.events);
  createXperExtension(first.pi);
  createXperExtension(second.pi);
  createXperExtension(third.pi);
  assert.deepEqual(first.commands, ["xper"]);
  assert.deepEqual(first.tools, ["xper_delegate"]);
  assert.equal(first.hooks.length, 5);
  for (const duplicate of [second, third]) {
    assert.deepEqual(duplicate.commands, []);
    assert.deepEqual(duplicate.tools, []);
    assert.deepEqual(duplicate.hooks, []);
  }
  assert.equal(host.subscriptions.size, 1);
  host.invalidate();
});

test("independent Pi event buses each register an extension", () => {
  for (let index = 0; index < 2; index++) {
    const host = runtime();
    const extension = extensionApi(host.events);
    createXperExtension(extension.pi);
    assert.deepEqual(extension.commands, ["xper"]);
    assert.deepEqual(extension.tools, ["xper_delegate"]);
    host.invalidate();
  }
});

test("runtime invalidation releases the claim before reload on the same event bus", () => {
  const bus = eventBus();
  const previous = runtime(bus);
  createXperExtension(extensionApi(previous.events).pi);
  previous.invalidate();
  assert.equal(previous.subscriptions.size, 0);
  const next = runtime(bus);
  const extension = extensionApi(next.events);
  createXperExtension(extension.pi);
  assert.deepEqual(extension.commands, ["xper"]);
  assert.equal(next.subscriptions.size, 1);
  next.invalidate();
});

test("failed registration releases its claim and leaves the loader free to try another factory", () => {
  for (const stage of ["command", "tool", "hook"] as const) {
    const host = runtime();
    const failed = extensionApi(host.events, stage);
    assert.throws(() => createXperExtension(failed.pi), new RegExp(`${stage} registration failed`));
    assert.equal(host.subscriptions.size, 0);
    const replacement = extensionApi(host.events);
    createXperExtension(replacement.pi);
    assert.deepEqual(replacement.commands, ["xper"]);
    assert.deepEqual(replacement.tools, ["xper_delegate"]);
    assert.equal(replacement.hooks.length, 5);
    host.invalidate();
  }
});

test("hosts without the optional event bus keep standalone registration available", () => {
  const extension = extensionApi();
  createXperExtension(extension.pi);
  assert.deepEqual(extension.commands, ["xper"]);
  assert.deepEqual(extension.tools, ["xper_delegate"]);
});
