import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AvailableModel } from "../bridge/xper-client.js";
import { ModelCatalogError } from "../execution/models.js";
import { failure, type InspectionResponse, parseRequest } from "./protocol.js";
import { describeRoles } from "./roles.js";

export class InspectionCatalog {
  private snapshot: AvailableModel[] | undefined;
  private loading: Promise<AvailableModel[]> | undefined;

  constructor(private readonly load: () => Promise<AvailableModel[]>) {}

  private models(refresh: boolean): Promise<AvailableModel[]> {
    if (!refresh && this.snapshot) return Promise.resolve(this.snapshot);
    if (this.loading) return this.loading;
    this.loading = this.load()
      .then((models) => {
        // Expose only contract fields, even if a loader supplies more metadata.
        this.snapshot = models.map(({ provider, model, reasoning }) => ({
          provider,
          model,
          reasoning,
        }));
        return this.snapshot;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  async handle(value: unknown): Promise<InspectionResponse> {
    const request = parseRequest(value);
    if (!("method" in request)) return request;
    try {
      if (request.method === "describe")
        return {
          schemaVersion: 1,
          id: request.id,
          result: { adapter: "pi", version: "0.1.0", roles: describeRoles() },
        };
      let models = await this.models(request.method === "refresh");
      if (request.method === "search") {
        const { query, provider } = request.params;
        if (provider) models = models.filter((model) => model.provider === provider);
        if (query.trim())
          models = fuzzyFilter(models, query, (model) => `${model.provider} ${model.model}`);
      }
      return { schemaVersion: 1, id: request.id, result: { models } };
    } catch (error) {
      return error instanceof ModelCatalogError
        ? failure(request.id, error.code, error.message)
        : failure(
            request.id,
            "CATALOG_UNAVAILABLE",
            "Pi model catalog is unavailable; check Pi and retry",
          );
    }
  }
}
