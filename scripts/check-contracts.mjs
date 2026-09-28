import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const protocol = read("schemas/protocol-v1.schema.json");
const validateProtocol = ajv.compile(protocol);
for (const fixture of read("fixtures/protocol-v1.json")) {
  assert.equal(validateProtocol(fixture.message), fixture.errorCode === undefined, fixture.name);
  if (fixture.resultSchema) {
    const validateResult = ajv.compile({ $ref: `${protocol.$id}#/$defs/${fixture.resultSchema}` });
    assert(
      validateResult(fixture.message.result),
      `${fixture.name}: ${ajv.errorsText(validateResult.errors)}`,
    );
  }
}
const validateArtifact = ajv.compile(read("schemas/knowledge-v1.schema.json"));
for (const fixture of read("fixtures/knowledge-v1.json")) {
  assert(
    validateArtifact(fixture.artifact),
    `${fixture.phase}: ${ajv.errorsText(validateArtifact.errors)}`,
  );
  assert(
    !validateArtifact({ ...fixture.artifact, schemaVersion: 2 }),
    "reject unsupported artifact versions",
  );
  assert(
    !validateArtifact({ ...fixture.artifact, inputs: ["same", "same"] }),
    "reject duplicate inputs",
  );
}
console.log("Shared protocol and knowledge artifact schemas match their fixtures.");
