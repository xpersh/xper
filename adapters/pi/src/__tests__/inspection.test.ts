import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AvailableModel } from "../bridge/xper-client.js";
import { ModelCatalogError } from "../execution/models.js";
import { InspectionCatalog } from "../inspection/catalog.js";
import { type InspectionResponse, parseRequest } from "../inspection/protocol.js";
import { describeRoles } from "../inspection/roles.js";
import { implementationReworkDefinition } from "../workflow/implementation/definition.js";
import { judgmentDefinition } from "../workflow/judgment/definition.js";
import { knowledgeDefinition } from "../workflow/knowledge/definition.js";
import { verificationDefinition } from "../workflow/verification/definition.js";

const models: AvailableModel[] = [
  { provider: "corp", model: "fast-coder", reasoning: false },
  { provider: "corp", model: "frontier-reasoner", reasoning: true },
  { provider: "local", model: "fast-coder", reasoning: false },
];
const request = (method: string, params?: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: "test",
  method,
  ...(params ? { params } : {}),
});
function resultModels(response: InspectionResponse): AvailableModel[] {
  assert("result" in response && "models" in response.result);
  return response.result.models;
}

test("inspection describes exactly the declared roles without loading Pi", async () => {
  const catalog = new InspectionCatalog(async () => {
    assert.fail("describe must not load Pi");
  });
  const result = await catalog.handle(request("describe"));
  assert("result" in result && "roles" in result.result);
  const roles = result.result.roles;
  const declared = [
    knowledgeDefinition,
    implementationReworkDefinition,
    verificationDefinition,
    judgmentDefinition,
  ].flatMap((definition) => definition.nodes.flatMap((node) => (node.role ? [node.role] : [])));
  assert.deepEqual(
    roles.map((role) => role.id),
    declared,
  );
  assert.equal(new Set(roles.map((role) => role.id)).size, 8);
  assert(roles.every((role) => role.label && role.guidance));
  assert.match(roles.find((role) => role.id === "design.designer")?.guidance ?? "", /frontier/);
  assert.deepEqual(describeRoles(), roles);
});

test("native fuzzy search reuses the snapshot and filters providers exactly", async () => {
  let calls = 0;
  const catalog = new InspectionCatalog(async () => {
    calls++;
    return models.map((model) => ({ ...model, apiKey: "synthetic-test-secret" }));
  });
  assert.deepEqual(resultModels(await catalog.handle(request("models"))), models);
  for (const query of ["fstcdr", "corp", "frntr", "no-matches"]) {
    const response = await catalog.handle(request("search", { query }));
    assert.deepEqual(
      resultModels(response),
      fuzzyFilter(models, query, (model) => `${model.provider} ${model.model}`),
    );
    assert(!JSON.stringify(response).includes("synthetic-test-secret"));
  }
  assert.deepEqual(
    resultModels(await catalog.handle(request("search", { query: "", provider: "corp" }))),
    models.slice(0, 2),
  );
  assert.deepEqual(
    resultModels(await catalog.handle(request("search", { query: "", provider: "cor" }))),
    [],
  );
  assert.equal(calls, 1);
});

test("concurrent first requests share one load and empty catalogs stay cached", async () => {
  let resolve: ((models: AvailableModel[]) => void) | undefined;
  let calls = 0;
  const catalog = new InspectionCatalog(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = [
    catalog.handle(request("models")),
    catalog.handle(request("search", { query: "fast" })),
  ];
  assert.equal(calls, 1);
  resolve?.([]);
  assert((await Promise.all(pending)).every((response) => resultModels(response).length === 0));
  assert.deepEqual(resultModels(await catalog.handle(request("models"))), []);
  assert.equal(calls, 1);
});

test("refresh replaces the snapshot and failure preserves it without exposing child output", async () => {
  let calls = 0;
  const catalog = new InspectionCatalog(async () => {
    calls++;
    if (calls === 3) throw new Error("secret provider configuration");
    return models.slice(0, calls);
  });
  assert.equal(resultModels(await catalog.handle(request("models"))).length, 1);
  assert.equal(resultModels(await catalog.handle(request("refresh"))).length, 2);
  const failed = await catalog.handle(request("refresh"));
  assert("error" in failed);
  assert.equal(failed.error.code, "CATALOG_UNAVAILABLE");
  assert(!JSON.stringify(failed).includes("secret provider"));
  assert.equal(resultModels(await catalog.handle(request("models"))).length, 2);
  assert.equal(calls, 3);
});

test("catalog failures remain distinguishable from no matching models", async () => {
  for (const code of ["CATALOG_TIMEOUT", "CATALOG_INVALID", "CATALOG_UNAVAILABLE"] as const) {
    const catalog = new InspectionCatalog(async () => {
      throw new ModelCatalogError(code, "Safe diagnostic");
    });
    const response = await catalog.handle(request("models"));
    assert("error" in response);
    assert.equal(response.error.code, code);
  }
});

test("invalid inspection requests are rejected before loading Pi", async () => {
  const catalog = new InspectionCatalog(async () => {
    assert.fail("invalid request reached Pi");
  });
  for (const value of [
    null,
    [],
    {},
    { ...request("models"), id: " " },
    { ...request("models"), id: "é".repeat(129) },
    { ...request("models"), extra: true },
    request("models", { query: "x" }),
    request("search"),
    request("search", { query: 4 }),
    request("search", { query: "", provider: " " }),
  ]) {
    const response = await catalog.handle(value);
    assert("error" in response);
    assert.equal(response.error.code, "INVALID_REQUEST");
  }
  const wrongVersion = await catalog.handle({ ...request("models"), schemaVersion: 2 });
  assert("error" in wrongVersion && wrongVersion.error.code === "UNSUPPORTED_VERSION");
  const unknownMethod = await catalog.handle(request("run.start"));
  assert("error" in unknownMethod && unknownMethod.error.code === "UNKNOWN_METHOD");
  const coercedMethod = await catalog.handle({ ...request("models"), method: ["models"] });
  assert("error" in coercedMethod && coercedMethod.error.code === "UNKNOWN_METHOD");
});

test("shared inspection fixtures agree with the runtime request boundary", async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../../../../fixtures/adapter-inspection-v1.json", import.meta.url),
      "utf8",
    ),
  ) as Array<{ name: string; valid: boolean; message: Record<string, unknown> }>;
  for (const fixture of fixtures.filter((fixture) => "method" in fixture.message)) {
    assert.equal("method" in parseRequest(fixture.message), fixture.valid, fixture.name);
  }
});
