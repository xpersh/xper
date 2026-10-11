import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runPiChild } from "../execution/child.js";
import { toolsForRole } from "../execution/roles.js";
import { resolveAgent } from "@xper/adapter-shared";
import { runJudgment } from "@xper/adapter-shared/execution";
import { parseJudgmentReport } from "../../../shared/dist/workflow/judgment/contract.js";
import {
  checkout,
  git,
  proposal,
} from "../../../shared/dist/__tests__/judgment-execution-harness.js";

test("Judge receives fresh frozen context and a complete host diff with only the read tool", async () => {
  const h = await checkout();
  try {
    const command = join(h.cwd, ".xper/fake-pi.cjs");
    await writeFile(
      command,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('.xper/child-args.json', JSON.stringify(process.argv.slice(2)));
process.stdin.once('data', data => {
  fs.writeFileSync('.xper/child-prompt.json', data);
  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'observed-provider',responseModel:'observed-model',content:[{type:'text',text:${JSON.stringify(proposal)}}]}})+'\\n');
  process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
});
`,
      { mode: 0o755 },
    );
    const result = await runJudgment(h.request, {
      readEvidence: h.readEvidence,
      runChild: (task, timeoutMs) =>
        runPiChild(task, h.cwd, h.signal.signal, {
          command,
          timeoutMs,
          systemPrompt: resolveAgent(h.request.role).systemPrompt,
          model: "synthetic/judge",
          tools: toolsForRole(h.request.role),
        }),
    });
    assert.equal(result.outcome, "succeeded", result.reason);
    assert(result.brief);
    parseJudgmentReport(result.brief, h.request.evaluation, "judge");
    const args = JSON.parse(
      await readFile(join(h.cwd, ".xper/child-args.json"), "utf8"),
    ) as string[];
    assert.equal(args[args.indexOf("--tools") + 1], "read");
    for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-context-files"])
      assert(args.includes(flag));
    const prompt = await readFile(join(h.cwd, ".xper/child-prompt.json"), "utf8");
    assert.match(prompt, /-base/);
    assert.match(prompt, /\+implemented/);
    assert(!prompt.includes(h.request.task));
    assert.equal(result.usage?.[0]?.model, "observed-model");
    assert.equal(git(h.cwd, "status", "--porcelain"), "");
  } finally {
    await rm(h.cwd, { recursive: true, force: true });
  }
});
