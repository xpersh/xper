import assert from "node:assert/strict";
import test from "node:test";
import { commands, judged } from "./judgment-harness.js";
import { setup } from "../../../shared/dist/__tests__/workflow-harness.js";

test("Pi approval presents Judge feedback as reopening and exposes exhausted delivery budgets", async () => {
  const h = await judged("REWORK_IMPLEMENTATION");
  try {
    const ui = commands(h.controller);
    const exact = `approve ${h.reportId} ${h.revision}`;
    assert((await ui.status()).includes(`/xper ${exact}`));
    assert.match(
      await ui.command(exact),
      /reopened: implementation.*Unresolved:.*budget exhausted/,
    );
    assert.doesNotMatch(await ui.status(), /closed:|recommendation not applied/);
    assert.match(await ui.status(), /unresolved: implementation assignment.*budget exhausted/);
    assert.match(await ui.command(exact), /existing decision/);
  } finally {
    await h.cleanup();
  }
});

test("Pi approve preserves human gates and requires an exact report and revision for closure", async () => {
  const knowledge = await setup({ humanGates: ["define"] });
  try {
    await knowledge.produce();
    await knowledge.controller.advanceRun();
    const definition = await knowledge.produce();
    assert(!definition.result.replayed && definition.result.artifactId);
    await knowledge.controller.advanceRun();
    const ui = commands(knowledge.controller);
    assert.match(await ui.command(`approve ${definition.result.artifactId}`), /"phase":"design"/);
  } finally {
    await knowledge.cleanup();
  }
  const h = await judged();
  try {
    const ui = commands(h.controller);
    const exact = `approve ${h.reportId} ${h.revision}`;
    assert((await ui.status()).includes(`/xper ${exact}`));
    assert.match(await ui.command(`approve ${h.reportId}`), /<reportId> <commit>/);
    assert.match(await ui.command(`${exact} extra`), /Provide the human gate/);
    assert.match(await ui.command(exact), /closed: accepted.*Run summary/);
    assert.match(await ui.status(), /closed: accepted.*Run summary/);
    assert.doesNotMatch(await ui.status(), /recommendation not applied/);
    assert.match(await ui.command(exact), /existing decision/);
  } finally {
    await h.cleanup();
  }
});
