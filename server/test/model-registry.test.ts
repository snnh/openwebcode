import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { FALLBACK_METADATA, lookupModelMetadata } from "../src/context/model-metadata.js";
import { ModelRegistry, type CatalogModel } from "../src/context/model-registry.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import type { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SettingsService } from "../src/settings-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-models-"));
  roots.push(root);
  return root;
}

function paths(root: string) {
  return { snapshotPath: path.join(root, "models.json"), manualPath: path.join(root, "models.manual.json") };
}

const syncedPath = (root: string) => path.join(root, "models.synced.json");

type FetchRoute = { match: string | RegExp; body: unknown; status?: number };

function fetchStub(routes: FetchRoute[], seen?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen?.push(url);
    for (const route of routes) {
      const hit = typeof route.match === "string" ? url.startsWith(route.match) : route.match.test(url);
      if (hit) {
        return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("model metadata lookup", () => {
  it("matches prefix, then conservative fallback", () => {
    expect(lookupModelMetadata("deepseek-reasoner").contextWindow).toBe(1_000_000);
    // 思维链回传默认：gpt/claude 关闭，其余（含未知模型）开启
    expect(lookupModelMetadata("gpt-4o-2024-11-20").maxOutput).toBe(16_000);
    expect(lookupModelMetadata("gpt-4o-2024-11-20").capabilities.modalities).toContain("image");
    expect(lookupModelMetadata("gpt-4o-2024-11-20").capabilities.imageOutput).toBe(false);
    expect(lookupModelMetadata("some-random-model")).toEqual(FALLBACK_METADATA);
    expect(lookupModelMetadata("some-random-model").capabilities.tools).toBe(true);
    expect(lookupModelMetadata("gpt-4o-2024-11-20").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("claude-opus-4-8").capabilities.reasoningContent).toBe(false);
    // 供应商命名空间形态 id 同样命中前缀（openai/gpt-*、anthropic/claude-*）
    expect(lookupModelMetadata("openai/gpt-5.6-sol").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("anthropic/claude-fable-5-free").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("z-ai/glm-5.2").capabilities.reasoningContent).toBe(true);
    expect(lookupModelMetadata("qwen3-max").capabilities.reasoningContent).toBe(true);
    expect(lookupModelMetadata("some-random-model").capabilities.reasoningContent).toBe(true);
  });
});

describe("ModelRegistry", () => {
  it("merges api entries from both protocols, skipping builtin ids", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([
        { match: "https://api.anthropic.com/v1/models", body: { data: [{ id: "claude-opus-4-8" }, { id: "claude-future-9", display_name: "Claude Future 9" }], has_more: false } },
        { match: "https://openai.test/models", body: { data: [{ id: "gpt-4o" }, { id: "gpt-weird" }] } },
      ]),
    });
    const report = await registry.refresh({ providers: [
      { provider: "anthropic", interfaceType: "anthropic-messages", apiKey: "sk-ant" },
      { provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test", apiKey: "sk-oai" },
    ] });
    expect(report.errors).toEqual([]);
    expect(report.added).toBe(4);

    const list = registry.list();
    // claude-opus-4-8 不再内置，经 API 拉取后按 metadata 前缀匹配成档
    const opus = list.find((model) => model.id === "claude-opus-4-8");
    expect(opus?.source).toBe("api");
    expect(opus?.contextWindow).toBe(256_000);
    const future = list.find((model) => model.id === "claude-future-9");
    expect(future).toMatchObject({ source: "api", provider: "anthropic", displayName: "Claude Future 9" });
    expect(future?.capabilities.modalities).toEqual(["text"]);
    const gpt4o = list.find((model) => model.id === "gpt-4o");
    expect(gpt4o).toMatchObject({ source: "api", provider: "openai", contextWindow: 128_000 });
    expect(list.find((model) => model.id === "gpt-weird")?.contextWindow).toBe(FALLBACK_METADATA.contextWindow);
    expect(registry.get("gpt-4o").provider).toBe("openai");
  });

  it("paginates anthropic model listing with after_id", async () => {
    const root = await tempDir();
    const seen: string[] = [];
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([
        { match: /after_id=m2$/, body: { data: [{ id: "claude-page-2" }], has_more: false }, },
        { match: "https://api.anthropic.com/v1/models", body: { data: [{ id: "claude-page-1" }], has_more: true, last_id: "m2" } },
      ], seen),
    });
    const report = await registry.refresh({ providers: [{ provider: "anthropic", interfaceType: "anthropic-messages", apiKey: "sk-ant" }] });
    expect(report.errors).toEqual([]);
    expect(report.added).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("after_id=m2");
  });

  it("never overwrites manual entries on refresh", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([{ match: "https://openai.test/models", body: { data: [{ id: "gpt-4o" }] } }]),
    });
    await registry.upsertManual({
      id: "gpt-4o", provider: "openai", source: "manual", contextWindow: 999, maxOutput: 99,
      capabilities: { modalities: ["text"], imageOutput: false, thinking: [], effort: [], tools: true },
    });
    const report = await registry.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(report.added).toBe(0);
    const gpt4o = registry.list().find((model) => model.id === "gpt-4o");
    expect(gpt4o?.source).toBe("manual");
    expect(gpt4o?.contextWindow).toBe(999);
    expect(registry.isManual("gpt-4o")).toBe(true);
  });

  it("keeps previous api entries and reports errors when a provider fails", async () => {
    const root = await tempDir();
    let fail = false;
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: (async () => {
        if (fail) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await registry.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(registry.list().some((model) => model.id === "gpt-4o")).toBe(true);

    fail = true;
    const report = await registry.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("openai");
    // 失败不清空旧目录
    expect(registry.list().some((model) => model.id === "gpt-4o")).toBe(true);
  });

  it("reports zero additions on a repeated refresh and filters non-chat models", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([
        {
          match: "https://openai.test/models",
          body: { data: [{ id: "gpt-4o" }, { id: "whisper-1" }, { id: "text-embedding-3-large" }, { id: "dall-e-3" }, { id: "tts-1" }] },
        },
      ]),
    });
    const first = await registry.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(first.added).toBe(1);
    expect(registry.list().map((model) => model.id)).not.toContain("whisper-1");
    expect(registry.list().map((model) => model.id)).not.toContain("text-embedding-3-large");

    const second = await registry.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(second.added).toBe(0);
    expect(registry.list().some((model) => model.id === "gpt-4o")).toBe(true);
  });

  it("reports an error when no credentials are configured", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    const report = await registry.refresh({ providers: [] });
    expect(report.errors).toEqual(["未配置任何 provider 凭据"]);
    expect(report.added).toBe(0);
  });

  it("removes cached API models when their provider is no longer enabled", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([{ match: "https://openai.test/models", body: { data: [{ id: "cached-model" }] } }]),
    });
    await registry.refresh({ providers: [{ provider: "local", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    expect(registry.list().some((model) => model.id === "cached-model" && model.provider === "local")).toBe(true);

    const report = await registry.refresh({ providers: [] });
    expect(report.errors).toEqual(["未配置任何 provider 凭据"]);
    expect(report.total).toBe(0);
    expect(registry.list().some((model) => model.id === "cached-model" && model.provider === "local")).toBe(false);

    const restored = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    expect(restored.list().some((model) => model.id === "cached-model" && model.provider === "local")).toBe(false);
  });

  it("restores api snapshot and manual entries across restarts", async () => {
    const root = await tempDir();
    const first = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([{ match: "https://openai.test/models", body: { data: [{ id: "gpt-4o" }] } }]),
    });
    await first.refresh({ providers: [{ provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" }] });
    await first.upsertManual({
      id: "my-model", provider: "manual", source: "manual", contextWindow: 1000, maxOutput: 100,
      capabilities: { modalities: ["text"], imageOutput: true, thinking: [], effort: [], tools: false },
    });

    const restored = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    expect(restored.list().find((model) => model.id === "gpt-4o")?.source).toBe("api");
    expect(restored.list().find((model) => model.id === "my-model")?.source).toBe("manual");
    expect(restored.get("my-model").capabilities.imageOutput).toBe(true);
    expect(await restored.removeManual("my-model")).toBe(true);
    expect(restored.list().some((model) => model.id === "my-model")).toBe(false);
    expect(await restored.removeManual("my-model")).toBe(false);
  });

  it("normalizes legacy saved capabilities with imageOutput disabled", async () => {
    const root = await tempDir();
    const registryPaths = paths(root);
    const legacyModel = {
      id: "legacy-image-model",
      provider: "manual",
      source: "manual",
      contextWindow: 4_096,
      maxOutput: 1_024,
      capabilities: { modalities: ["text"], thinking: [], effort: [], tools: true },
    };
    await writeFile(registryPaths.manualPath, JSON.stringify({
      version: 1,
      updatedAt: "2026-07-21T00:00:00.000Z",
      models: [legacyModel],
    }));
    await writeFile(registryPaths.snapshotPath, JSON.stringify({
      version: 1,
      updatedAt: "2026-07-21T00:00:00.000Z",
      models: [{ ...legacyModel, id: "legacy-api-model", provider: "openai", source: "api" }],
    }));

    const registry = await ModelRegistry.load({ ...registryPaths, fetchImpl: fetchStub([]) });
    expect(registry.get("legacy-image-model").capabilities.imageOutput).toBe(false);
    expect(registry.list().find((model) => model.id === "legacy-image-model")?.capabilities.imageOutput).toBe(false);
    expect(registry.get("legacy-api-model").capabilities.imageOutput).toBe(false);
    expect(registry.list().find((model) => model.id === "legacy-api-model")?.capabilities.imageOutput).toBe(false);
  });

  it("syncs a separate remote catalog snapshot while keeping same-id providers independent", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    expect(registry.syncStatus()).toEqual({ count: 0 });
    await registry.upsertManual({
      id: "remote-overridden",
      provider: "manual",
      source: "manual",
      contextWindow: 9_999,
      maxOutput: 999,
      capabilities: { modalities: ["text"], imageOutput: false, thinking: [], effort: [], tools: true },
    });
    const remoteDocument = {
      version: 1,
      updatedAt: "2026-07-21T01:02:03.000Z",
      models: [
        {
          id: "remote-overridden",
          provider: "remote-provider",
          contextWindow: 65_536,
          maxOutput: 4_096,
          capabilities: { modalities: ["text", "image", "video"], thinking: ["enabled"], effort: ["high"], tools: false },
        },
        {
          id: "remote-image-video",
          provider: "remote-provider",
          displayName: "Remote Image + Video Input",
          contextWindow: 65_536,
          maxOutput: 4_096,
          capabilities: { modalities: ["text", "image", "video"], thinking: ["enabled"], effort: ["high"], tools: false },
        },
      ],
    };

    const result = await registry.syncCatalogFromUrl("https://catalog.test/models.json", {
      fetchImpl: fetchStub([{ match: "https://catalog.test/models.json", body: remoteDocument }]),
      timeoutMs: 123,
    });

    expect(result).toEqual({ ok: true, count: 2, updatedAt: remoteDocument.updatedAt });
    expect(registry.syncStatus()).toEqual({ count: 2, updatedAt: remoteDocument.updatedAt });
    expect(registry.list().find((model) => model.id === "remote-overridden" && model.provider === "manual")).toMatchObject({
      source: "manual", provider: "manual", contextWindow: 9_999,
    });
    expect(registry.list().find((model) => model.id === "remote-overridden" && model.provider === "remote-provider")).toMatchObject({
      source: "synced", contextWindow: 65_536,
    });
    const synced = registry.list().find((model) => model.id === "remote-image-video");
    expect(synced).toMatchObject({ source: "synced", provider: "remote-provider", displayName: "Remote Image + Video Input" });
    expect(synced?.capabilities).toEqual({
      modalities: ["text", "image", "video"],
      imageOutput: false,
      thinking: ["enabled"],
      effort: ["high"],
      tools: false,
      reasoningContent: true,
    });

    const snapshot = JSON.parse(await readFile(syncedPath(root), "utf8"));
    expect(snapshot).toMatchObject({ version: 1, updatedAt: remoteDocument.updatedAt });
    expect(snapshot.models).toHaveLength(2);
    const restored = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    expect(restored.list().find((model) => model.id === "remote-image-video")?.source).toBe("synced");
    expect(restored.syncStatus()).toEqual({ count: 2, updatedAt: remoteDocument.updatedAt });
  });

  async function registryWithSyncedCatalog(root: string): Promise<ModelRegistry> {
    const registry = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    const seeded = await registry.syncCatalogFromUrl("https://catalog.test/seed.json", {
      fetchImpl: fetchStub([{
        match: "https://catalog.test/seed.json",
        body: {
          version: 1,
          updatedAt: "2026-07-21T00:00:00.000Z",
          models: [{ id: "synced-before-failure", provider: "remote", contextWindow: 10_000, maxOutput: 1_000, capabilities: { modalities: ["text"] } }],
        },
      }]),
    });
    expect(seeded).toMatchObject({ ok: true, count: 1 });
    return registry;
  }

  async function expectFailedSyncToKeepSnapshot(
    registry: ModelRegistry,
    root: string,
    fetchImpl: typeof fetch,
  ): Promise<void> {
    const beforeList = registry.list();
    const beforeStatus = registry.syncStatus();
    const beforeSnapshot = await readFile(syncedPath(root), "utf8");
    const result = await registry.syncCatalogFromUrl("https://catalog.test/failing.json", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(registry.list()).toEqual(beforeList);
    expect(registry.syncStatus()).toEqual(beforeStatus);
    expect(await readFile(syncedPath(root), "utf8")).toBe(beforeSnapshot);
  }

  it("rejects invalid JSON without mutating the prior synced catalog", async () => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch);
  });

  it("rejects an unsupported remote catalog version without mutating the prior synced catalog", async () => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, fetchStub([{
      match: "https://catalog.test/failing.json",
      body: { version: 2, models: [{ id: "replacement", provider: "remote" }] },
    }]));
  });

  it("rejects an empty remote catalog without mutating the prior synced catalog", async () => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, fetchStub([{
      match: "https://catalog.test/failing.json",
      body: { version: 1, models: [] },
    }]));
  });

  it("rejects a remote catalog without an ISO update time without mutating the prior synced catalog", async () => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, fetchStub([{
      match: "https://catalog.test/failing.json",
      body: {
        version: 1,
        updatedAt: "not-an-iso-time",
        models: [{ id: "replacement", provider: "remote", contextWindow: 10_000, maxOutput: 1_000 }],
      },
    }]));
  });

  it("keeps the prior synced catalog when the remote fetch fails", async () => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, (async () => {
      throw new Error("network offline");
    }) as unknown as typeof fetch);
  });
});

describe("models API", () => {
  async function fixture(routes: FetchRoute[]) {
    const root = await tempDir();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "model-pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const core = new CoreClient(path.join(root, "unused-core"));
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    const models = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub(routes),
      onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
    });
    const providerProfilesRuntime = {
      refreshModels: () => models.refresh({ providers: [
        { provider: "anthropic", interfaceType: "anthropic-messages", apiKey: "sk-ant" },
        { provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" },
      ] }),
    } as unknown as ProviderProfilesRuntime;
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, settings, models, providerProfilesRuntime });
    return { app, models, observed };
  }

  it("exposes the persisted remote catalog sync status", async () => {
    const { app, models } = await fixture([]);
    try {
      const before = await app.inject({ method: "GET", url: "/api/models/sync-status" });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ count: 0 });

      const updatedAt = "2026-07-21T11:22:33.000Z";
      await models.syncCatalogFromUrl("https://catalog.test/status.json", {
        fetchImpl: fetchStub([{
          match: "https://catalog.test/status.json",
          body: {
            version: 1,
            updatedAt,
            models: [{
              id: "status-model",
              provider: "remote",
              contextWindow: 8_192,
              maxOutput: 1_024,
              capabilities: { modalities: ["text"] },
            }],
          },
        }]),
      });

      const after = await app.inject({ method: "GET", url: "/api/models/sync-status" });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ count: 1, updatedAt });
    } finally {
      await app.close();
    }
  });

  it("starts with an empty catalog and refreshes models with source via provider credentials", async () => {
    const { app, observed } = await fixture([
      { match: "https://api.anthropic.com/v1/models", body: { data: [{ id: "claude-future-9", display_name: "Claude Future 9" }], has_more: false } },
      { match: "https://openai.test/models", body: { data: [{ id: "gpt-4o" }] } },
    ]);
    try {
      const before = (await app.inject({ method: "GET", url: "/api/models" })).json<CatalogModel[]>();
      expect(before).toEqual([]);

      const refresh = await app.inject({ method: "POST", url: "/api/models/refresh" });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).toMatchObject({ added: 2, errors: [] });

      const after = (await app.inject({ method: "GET", url: "/api/models" })).json<CatalogModel[]>();
      expect(after.find((model) => model.id === "claude-future-9")).toMatchObject({ source: "api", displayName: "Claude Future 9" });
      expect(after.find((model) => model.id === "gpt-4o")?.source).toBe("api");
      expect(observed.some((event) => event.type === "models.updated")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("upserts and deletes manual models with validation", async () => {
    const { app } = await fixture([]);
    try {
      const created = await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { provider: "openai", contextWindow: 64_000 } });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ id: "my-custom", provider: "openai", source: "manual", contextWindow: 64_000 });

      const listed = (await app.inject({ method: "GET", url: "/api/models" })).json<CatalogModel[]>();
      expect(listed.find((model) => model.id === "my-custom")?.source).toBe("manual");

      expect((await app.inject({ method: "PUT", url: "/api/models/bad", payload: { contextWindow: -1 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/models/no-provider", payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/models/bad-caps", payload: { provider: "openai", capabilities: { tools: "yes" } } })).statusCode).toBe(400);
      // capabilities 数组元素枚举校验：modalities/thinking/effort 越界一律 400
      const badEnum = { modalities: ["audio"], imageOutput: false, thinking: ["sometimes"], effort: ["ultra"], tools: true };
      expect((await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: badEnum } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: { modalities: ["text"], imageOutput: false, thinking: [], effort: ["extreme"], tools: true } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: { modalities: ["text"], imageOutput: "yes", thinking: [], effort: [], tools: true } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: { modalities: ["text"], thinking: [], effort: [], tools: true } } })).statusCode).toBe(400);
      // 合法 capabilities 持久化（含 thinking/effort 覆盖）；未知的
      // videoOutput 不能泄漏为 API 合同的一部分。
      const caps = { modalities: ["text", "image", "video"], imageOutput: true, thinking: ["adaptive", "disabled"], effort: ["low", "high"], tools: false };
      const updated = await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: { ...caps, videoOutput: true }, maxOutput: 8_000 } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ id: "my-custom", source: "manual", maxOutput: 8_000, capabilities: caps });
      expect(updated.json()).not.toHaveProperty("capabilities.videoOutput");
      expect((await app.inject({ method: "DELETE", url: "/api/models/nonexistent" })).statusCode).toBe(409);
      expect((await app.inject({ method: "DELETE", url: "/api/models/my-custom" })).statusCode).toBe(204);
      const after = (await app.inject({ method: "GET", url: "/api/models" })).json<CatalogModel[]>();
      expect(after.some((model) => model.id === "my-custom")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
