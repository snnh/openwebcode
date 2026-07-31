import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/context/model-registry.js";
import { PricingCatalog, type SyncResult } from "../src/cost/pricing-catalog.js";
import type { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { fetchStub, type FetchRoute } from "./helpers/fetch-stub.js";
import { makeTestApp } from "./helpers/test-app.js";

class StubSyncPricingCatalog extends PricingCatalog {
  readonly syncedUrls: string[] = [];

  constructor(filePath: string, private readonly result: SyncResult) {
    super(filePath);
  }

  override async syncFromUrl(url: string): Promise<SyncResult> {
    this.syncedUrls.push(url);
    return this.result;
  }
}

async function fixture(options: {
  catalogSyncUrl?: string;
  pricingSyncUrl?: string;
  fetchRoutes?: FetchRoute[];
  pricingResult?: SyncResult;
} = {}) {
  const seen: string[] = [];
  const setup = await makeTestApp({
    tempPrefix: "owc-model-sync-api-",
    pricing: (root) => new StubSyncPricingCatalog(
      path.join(root, "model-pricing.json"),
      options.pricingResult ?? { ok: true, count: 2, updatedAt: "2026-07-21T12:00:00.000Z" },
    ),
    agent: "real",
    core: "real",
    settingsEnv: {
      ...(options.catalogSyncUrl ? { OWC_MODELS_CATALOG_SYNC_URL: options.catalogSyncUrl } : {}),
      ...(options.pricingSyncUrl ? { OWC_MODELS_PRICING_SYNC_URL: options.pricingSyncUrl } : {}),
    },
    models: (root, events) => ModelRegistry.load({
      snapshotPath: path.join(root, "models.json"),
      manualPath: path.join(root, "models.manual.json"),
      fetchImpl: fetchStub(options.fetchRoutes ?? [], seen),
      onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
    }),
    providerProfilesRuntime: (models) => ({
      refreshModels: () => models!.refresh({ providers: [{ provider: "anthropic", interfaceType: "anthropic-messages", apiKey: "sk-route-test" }] }),
    }) as unknown as ProviderProfilesRuntime,
  });
  return { app: setup.app, models: setup.models!, pricing: setup.pricing, observed: setup.observed, seen };
}

describe("model sync API", () => {
  it("syncs configured remote catalogs and keeps refresh report fields", async () => {
    const catalogUrl = "https://catalog.example.test/models.json";
    const pricingUrl = "https://catalog.example.test/pricing.json";
    const remoteCatalog = {
      version: 1,
      updatedAt: "2026-07-21T11:00:00.000Z",
      models: [{
        id: "remote-image-video",
        provider: "remote",
        contextWindow: 64_000,
        maxOutput: 4_000,
        capabilities: { modalities: ["text", "image", "video"], imageOutput: true, thinking: [], effort: [], tools: true },
      }],
    };
    const setup = await fixture({
      catalogSyncUrl: catalogUrl,
      pricingSyncUrl: pricingUrl,
      fetchRoutes: [
        { match: catalogUrl, body: remoteCatalog },
        { match: "https://api.anthropic.com/v1/models", body: { data: [{ id: "claude-route-test" }], has_more: false } },
      ],
    });
    try {
      const catalogSync = await setup.app.inject({ method: "POST", url: "/api/models/sync" });
      expect(catalogSync.statusCode).toBe(200);
      expect(catalogSync.json<SyncResult>()).toEqual({ ok: true, count: 1, updatedAt: remoteCatalog.updatedAt });
      expect(setup.models.list().find((model) => model.id === "remote-image-video")).toMatchObject({ source: "synced" });

      const refresh = await setup.app.inject({ method: "POST", url: "/api/models/refresh" });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).toMatchObject({
        added: 1,
        total: 1,
        errors: [],
        catalogSync: { ok: true, count: 1, updatedAt: remoteCatalog.updatedAt },
      });
      expect(setup.seen.filter((url) => url === catalogUrl)).toHaveLength(2);
      expect(setup.seen.some((url) => url.startsWith("https://api.anthropic.com/v1/models"))).toBe(true);

      const pricingSync = await setup.app.inject({ method: "POST", url: "/api/model-pricing/sync" });
      expect(pricingSync.statusCode).toBe(200);
      expect(pricingSync.json<SyncResult>()).toEqual({ ok: true, count: 2, updatedAt: "2026-07-21T12:00:00.000Z" });
      expect(setup.pricing.syncedUrls).toEqual([pricingUrl]);
      expect(setup.observed.filter((event) => event.type === "model.pricing_updated")).toHaveLength(1);
    } finally {
      await setup.app.close();
    }
  });

  it("returns a safe SyncResult when a remote URL is not configured", async () => {
    const setup = await fixture();
    try {
      const catalogSync = await setup.app.inject({ method: "POST", url: "/api/models/sync" });
      expect(catalogSync.statusCode).toBe(200);
      expect(catalogSync.json<SyncResult>()).toEqual({ ok: false, error: "Model catalog sync URL is not configured" });

      const pricingSync = await setup.app.inject({ method: "POST", url: "/api/model-pricing/sync" });
      expect(pricingSync.statusCode).toBe(200);
      expect(pricingSync.json<SyncResult>()).toEqual({ ok: false, error: "Model pricing sync URL is not configured" });
      expect(setup.pricing.syncedUrls).toEqual([]);
      expect(setup.observed.filter((event) => event.type === "model.pricing_updated")).toHaveLength(0);

      const refresh = await setup.app.inject({ method: "POST", url: "/api/models/refresh" });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).not.toHaveProperty("catalogSync");
    } finally {
      await setup.app.close();
    }
  });
});
