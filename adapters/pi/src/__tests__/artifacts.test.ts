import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveArtifact } from "../knowledge/artifacts.js";

test("artifact writer returns a workspace-relative path and preserves existing evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-brief-"));
  try {
    const path = await saveArtifact(cwd, "attempt-1", "original evidence");
    assert.equal(path, ".xper/artifacts/discovery-brief-attempt-1.md");
    await assert.rejects(saveArtifact(cwd, "attempt-1", "replacement"), { code: "EEXIST" });
    assert.equal(await readFile(join(cwd, path), "utf8"), "original evidence");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("artifact writer rejects IDs that cannot be used as a filename before creating files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xper-brief-"));
  try {
    for (const id of [" ", "one/two", "one\\two", "one\0two"]) {
      await assert.rejects(saveArtifact(cwd, id, "evidence"), /Invalid attempt ID/);
    }
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
