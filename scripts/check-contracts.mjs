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
const validateEvent = ajv.compile({ $ref: `${protocol.$id}#/$defs/recordedEvent` });
const recordedEvent = read("fixtures/protocol-v1.json").find(
  (fixture) => fixture.message.method === "event.append",
).message.params.events[0];
assert(validateEvent(recordedEvent), "accept extensible phase labels");
for (const invalid of [
  { ...recordedEvent, schemaVersion: 2 },
  { ...recordedEvent, eventId: " " },
  { ...recordedEvent, occurredAt: -1 },
  { ...recordedEvent, occurredAt: Number.MAX_SAFE_INTEGER + 1 },
  { ...recordedEvent, data: [] },
  { ...recordedEvent, extraEnvelopeField: true },
]) {
  assert(!validateEvent(invalid), "reject malformed recording envelope");
}
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
  if (fixture.artifact.output.kind === "execution_plan") {
    const invalid = structuredClone(fixture.artifact);
    invalid.output.assignments[0].role = "implementation.reviewer";
    assert(!validateArtifact(invalid), "reject unsupported delivery roles");
  }
}
const validateImplementation = ajv.compile(read("schemas/implementation-v1.schema.json"));
for (const fixture of read("fixtures/implementation-v1.json")) {
  assert(
    validateImplementation(fixture.artifact),
    `${fixture.name}: ${ajv.errorsText(validateImplementation.errors)}`,
  );
  assert(
    !validateImplementation({ ...fixture.artifact, schemaVersion: 2 }),
    "reject unsupported implementation artifact versions",
  );
  const claimed = structuredClone(fixture.artifact);
  claimed.output.tests[0].passed = true;
  assert(!validateImplementation(claimed), "reject model-claimed test outcomes");
  const escaped = structuredClone(fixture.artifact);
  escaped.output.tests[0].outputPath = "../test.log";
  assert(!validateImplementation(escaped), "confine implementation output references");
  const external = structuredClone(fixture.artifact);
  external.output.changedFiles[0] = "../outside.ts";
  assert(!validateImplementation(external), "confine implementation source paths");
}
const validateVerification = ajv.compile(read("schemas/verification-v1.schema.json"));
for (const fixture of read("fixtures/verification-v1.json")) {
  assert(
    validateVerification(fixture.artifact),
    `${fixture.name}: ${ajv.errorsText(validateVerification.errors)}`,
  );
  assert(
    !validateVerification({ ...fixture.artifact, schemaVersion: 2 }),
    "reject unsupported verification artifact versions",
  );
  if (fixture.artifact.output.verdict === "verified") {
    const mismatched = structuredClone(fixture.artifact);
    mismatched.output.verdict = "rejected";
    assert(!validateVerification(mismatched), "rejected verification needs rejection evidence");
    const failedApproval = structuredClone(fixture.artifact);
    failedApproval.output.tests[0].exitCode = 1;
    assert(!validateVerification(failedApproval), "verified review cannot hide a failed host test");
  } else if (fixture.artifact.output.rejection?.knowledgeFeedback) {
    const historical = structuredClone(fixture.artifact);
    delete historical.output.rejection.knowledgeFeedback;
    assert(validateVerification(historical), "accept historical verification-v1 rejection");
    const unknownFeedback = structuredClone(fixture.artifact);
    unknownFeedback.output.rejection.knowledgeFeedback.reason = "missing_context";
    assert(!validateVerification(unknownFeedback), "reject unsupported delivery feedback target");
    const malformedFeedback = structuredClone(fixture.artifact);
    malformedFeedback.output.rejection.knowledgeFeedback = "ambiguous_criteria";
    assert(!validateVerification(malformedFeedback), "reject non-object delivery feedback");
    const extendedFeedback = structuredClone(fixture.artifact);
    extendedFeedback.output.rejection.knowledgeFeedback.extra = true;
    assert(!validateVerification(extendedFeedback), "reject unknown delivery feedback fields");
  }
  const unsupportedCommit = structuredClone(fixture.artifact);
  unsupportedCommit.output.evaluatedCommit = "not-a-commit";
  assert(!validateVerification(unsupportedCommit), "reject malformed evaluated commits");
  const blankId = structuredClone(fixture.artifact);
  blankId.output.implementationArtifactId = " ";
  assert(!validateVerification(blankId), "reject blank verification identities");
  const incomplete = structuredClone(fixture.artifact);
  incomplete.output.criteria = [];
  assert(!validateVerification(incomplete), "require verification criterion evidence");
  const escaped = structuredClone(fixture.artifact);
  escaped.output.tests[0].outputPath = "../test.log";
  assert(!validateVerification(escaped), "confine verification output references");
  const claimed = structuredClone(fixture.artifact);
  claimed.output.tests[0].passed = true;
  assert(!validateVerification(claimed), "reject model-claimed verification test outcomes");
}
console.log("Shared protocol and adapter artifact schemas match their fixtures.");
