import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { FALLBACK_METADATA, lookupModelMetadata } from "../src/context/model-metadata.js";
import { estimateTokens } from "../src/context/model-profile.js";
import { ModelRegistry, type CatalogModel } from "../src/context/model-registry.js";
import { PricingCatalog, type SyncResult } from "../src/cost/pricing-catalog.js";
import type { CoreClient } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import type { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { fetchStub, type FetchRoute } from "./helpers/fetch-stub.js";
import { tempRoot } from "./helpers/temp-roots.js";
import { makeTestApp } from "./helpers/test-app.js";

const tempDir = () => tempRoot("owc-models-");

function paths(root: string) {
  return { snapshotPath: path.join(root, "models.json"), manualPath: path.join(root, "models.manual.json") };
}

const syncedPath = (root: string) => path.join(root, "models.synced.json");

describe("model metadata lookup", () => {
  it("matches prefix, then conservative fallback", () => {
    // 具体窗口值随模型目录更新而变：断言命中定制元数据（区别于兜底）与合理区间，不锁定目录内容
    const deepseekReasoner = lookupModelMetadata("deepseek-reasoner");
    expect(deepseekReasoner).not.toEqual(FALLBACK_METADATA);
    expect(deepseekReasoner.contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(deepseekReasoner.contextWindow).toBeLessThanOrEqual(4_000_000);
    expect(lookupModelMetadata("deepseek-v4-flash").contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(lookupModelMetadata("glm-5.2").contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(lookupModelMetadata("kimi-k3").contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(lookupModelMetadata("kimi-k2.7-code").contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(lookupModelMetadata("gemini-3.7-flash").contextWindow).toBeGreaterThanOrEqual(100_000);
    // 未知模型走兜底（默认 256K）
    expect(FALLBACK_METADATA.contextWindow).toBeGreaterThanOrEqual(100_000);
    expect(FALLBACK_METADATA.contextWindow).toBeLessThanOrEqual(4_000_000);
    // 模型名含 vision 标记 → 默认声明图片输入（deepseek-v4-flash-vision-exp 等）
    expect(lookupModelMetadata("deepseek-v4-flash-vision-exp").capabilities.modalities).toContain("image");
    expect(lookupModelMetadata("gpt-4o-2024-11-20").capabilities.modalities).toContain("image");
    expect(lookupModelMetadata("some-random-model")).toEqual(FALLBACK_METADATA);
    expect(lookupModelMetadata("gpt-4o-2024-11-20").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("claude-opus-4-8").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("openai/gpt-5.6-sol").capabilities.reasoningContent).toBe(false);
    expect(lookupModelMetadata("z-ai/glm-5.2").capabilities.reasoningContent).toBe(true);
    expect(lookupModelMetadata("qwen3-max").capabilities.reasoningContent).toBe(true);
    expect(lookupModelMetadata("some-random-model").capabilities.reasoningContent).toBe(true);
    expect(lookupModelMetadata("gpt-5").capabilities.responsesEncryptedReplay).toBe(false);
    expect(lookupModelMetadata("some-random-model").capabilities.responsesEncryptedReplay).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("ASCII 按 ~4 字符/token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(1);
  });

  it("非 ASCII（CJK）按 ~1.5 字符/token 加权，不再低估 3-4 倍", () => {
    // 4 个汉字：旧口径 ceil(4/4)=1，实际约 4 token，新口径 ceil(4/1.5)=3；
    // 系数微调容忍区间 [2,4]，但不得低估到 1
    expect(estimateTokens("你好世界")).toBeGreaterThanOrEqual(2);
    expect(estimateTokens("你好世界")).toBeLessThanOrEqual(4);
    expect(estimateTokens("你")).toBe(1);
  });

  it("中英混排分段加权", () => {
    // "abcd" → 1，"你好" → ceil 边界内合计 ceil(1 + 1.333) = 3（系数微调容忍 [2,4]）
    expect(estimateTokens("abcd你好")).toBeGreaterThanOrEqual(2);
    expect(estimateTokens("abcd你好")).toBeLessThanOrEqual(4);
    // 长中文串的估算量级接近实际 token 数（约 1 字符/token）
    const text = "中文会话内容".repeat(100);
    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
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
      id: "gpt-4o", provider: "openai", source: "manual", contextWindow: 999,
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
      id: "my-model", provider: "manual", source: "manual", contextWindow: 1000,
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

  it("prefers manual declaration over api entries when the same id exists under multiple providers", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({
      ...paths(root),
      fetchImpl: fetchStub([{ match: "https://gateway.test/models", body: { data: [{ id: "hub-model" }] } }]),
    });
    await registry.refresh({ providers: [{ provider: "gateway", interfaceType: "openai-chat-completions", baseURL: "https://gateway.test" }] });
    // api 自动拉取条目：能力为内置兜底（无 image）
    expect(registry.get("hub-model").capabilities.modalities).not.toContain("image");
    // 用户在同 id 的另一 provider 下声明 image 支持
    await registry.upsertManual({
      id: "hub-model", provider: "official", source: "manual", contextWindow: 128_000,
      capabilities: { modalities: ["text", "image"], imageOutput: false, thinking: [], effort: [], tools: true },
    });
    // 无 provider 查询：用户声明（manual）优先于 api 自动条目，不被内置兜底能力盖过
    const profile = registry.get("hub-model");
    expect(profile.provider).toBe("official");
    expect(profile.capabilities.modalities).toContain("image");
    // 带 provider 查询仍精确命中对应条目
    expect(registry.get("hub-model", "gateway").capabilities.modalities).not.toContain("image");
    // list() 展示层不变：不同 provider 的同 id 条目并存
    expect(registry.list().filter((model) => model.id === "hub-model")).toHaveLength(2);
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
    // 旧目录文件里已废弃的 maxOutput 字段被静默丢弃，不再进入目录模型
    expect(registry.get("legacy-image-model")).not.toHaveProperty("maxOutput");
    expect(registry.get("legacy-api-model")).not.toHaveProperty("maxOutput");
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
          capabilities: { modalities: ["text", "image", "video"], thinking: ["enabled"], effort: ["high"], tools: false },
        },
        {
          id: "remote-image-video",
          provider: "remote-provider",
          displayName: "Remote Image + Video Input",
          contextWindow: 65_536,
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
      responsesEncryptedReplay: false,
    });

    const snapshot = JSON.parse(await readFile(syncedPath(root), "utf8"));
    expect(snapshot).toMatchObject({ version: 1, updatedAt: remoteDocument.updatedAt });
    expect(snapshot.models).toHaveLength(2);
    const restored = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    expect(restored.list().find((model) => model.id === "remote-image-video")?.source).toBe("synced");
    expect(restored.syncStatus()).toEqual({ count: 2, updatedAt: remoteDocument.updatedAt });
  });

  it("normalizes responsesEncryptedReplay and minimal effort from synced catalogs, rejecting non-booleans", async () => {
    const root = await tempDir();
    const registry = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    const ok = await registry.syncCatalogFromUrl("https://catalog.test/replay.json", {
      fetchImpl: fetchStub([{
        match: "https://catalog.test/replay.json",
        body: {
          version: 1,
          updatedAt: "2026-07-21T00:00:00.000Z",
          models: [
            {
              id: "replay-on",
              provider: "remote",
              contextWindow: 10_000,
              capabilities: { modalities: ["text"], effort: ["minimal"], responsesEncryptedReplay: true },
            },
            {
              id: "replay-off",
              provider: "remote",
              contextWindow: 10_000,
              capabilities: { modalities: ["text"], responsesEncryptedReplay: false },
            },
          ],
        },
      }]),
    });
    expect(ok.ok).toBe(true);
    const on = registry.list().find((model) => model.id === "replay-on");
    expect(on?.capabilities.responsesEncryptedReplay).toBe(true);
    expect(on?.capabilities.effort).toEqual(["minimal"]);
    const off = registry.list().find((model) => model.id === "replay-off");
    expect(off?.capabilities.responsesEncryptedReplay).toBe(false);

    // 非布尔 responsesEncryptedReplay 声明整体拒绝，且不改动既有 synced 目录
    const before = registry.list();
    const bad = await registry.syncCatalogFromUrl("https://catalog.test/replay-bad.json", {
      fetchImpl: fetchStub([{
        match: "https://catalog.test/replay-bad.json",
        body: {
          version: 1,
          updatedAt: "2026-07-21T00:00:00.000Z",
          models: [
            {
              id: "replay-bad",
              provider: "remote",
              contextWindow: 10_000,
              capabilities: { modalities: ["text"], responsesEncryptedReplay: "yes" },
            },
          ],
        },
      }]),
    });
    expect(bad).toEqual({ ok: false, error: "Invalid catalog capabilities.responsesEncryptedReplay" });
    expect(registry.list()).toEqual(before);
  });

  async function registryWithSyncedCatalog(root: string): Promise<ModelRegistry> {
    const registry = await ModelRegistry.load({ ...paths(root), fetchImpl: fetchStub([]) });
    const seeded = await registry.syncCatalogFromUrl("https://catalog.test/seed.json", {
      fetchImpl: fetchStub([{
        match: "https://catalog.test/seed.json",
        body: {
          version: 1,
          updatedAt: "2026-07-21T00:00:00.000Z",
          models: [{ id: "synced-before-failure", provider: "remote", contextWindow: 10_000, capabilities: { modalities: ["text"] } }],
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

  // 各非法远端目录（或拉取失败）一律拒绝且不改动既有同步快照
  it.each([
    {
      name: "invalid JSON",
      fetchImpl: () => (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    },
    {
      name: "an unsupported remote catalog version",
      fetchImpl: () => fetchStub([{
        match: "https://catalog.test/failing.json",
        body: { version: 2, models: [{ id: "replacement", provider: "remote" }] },
      }]),
    },
    {
      name: "an empty remote catalog",
      fetchImpl: () => fetchStub([{
        match: "https://catalog.test/failing.json",
        body: { version: 1, models: [] },
      }]),
    },
    {
      name: "a remote catalog without an ISO update time",
      fetchImpl: () => fetchStub([{
        match: "https://catalog.test/failing.json",
        body: {
          version: 1,
          updatedAt: "not-an-iso-time",
          models: [{ id: "replacement", provider: "remote", contextWindow: 10_000 }],
        },
      }]),
    },
    {
      name: "a failing remote fetch",
      fetchImpl: () => (async () => { throw new Error("network offline"); }) as unknown as typeof fetch,
    },
  ])("rejects $name without mutating the prior synced catalog", async ({ fetchImpl }) => {
    const root = await tempDir();
    const registry = await registryWithSyncedCatalog(root);
    await expectFailedSyncToKeepSnapshot(registry, root, fetchImpl());
  });
});

/**
 * AgentRunner 会话级模型热切换：下一次 run 使用更新后的 model / thinking / effort。
 */
describe("AgentRunner model hot switching", () => {
  it("uses the updated model, thinking, and effort on the next run", async () => {
    const root = await tempRoot("owc-hot-model-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "claude-haiku-4-5" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "first");
    await sessions.updateConfig(session.id, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      thinking: "adaptive",
      effort: "xhigh",
    });
    await runner.run(session.id, "second");

    expect(requests[0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(requests[0]).not.toHaveProperty("thinking");
    expect(requests[1]).toMatchObject({ model: "claude-opus-4-8", thinking: "adaptive", effort: "xhigh" });
  });

  it("sends responsesEncryptedReplay only when the effective model declares the capability", async () => {
    const root = await tempRoot("owc-replay-wire-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai", model: "gpt-5" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "openai",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "first");
    // 加密思维链回放默认关闭（用户明确要求「加密默认关闭」）：gpt-5 不再自动下发
    expect(requests[0]).toMatchObject({ model: "gpt-5" });
    expect(requests[0]).not.toHaveProperty("responsesEncryptedReplay");

    await sessions.updateConfig(session.id, { provider: "openai", model: "deepseek-chat" });
    await runner.run(session.id, "second");
    expect(requests[1]).toMatchObject({ model: "deepseek-chat" });
    expect(requests[1]).not.toHaveProperty("responsesEncryptedReplay");
  });
});

describe("models API", () => {
  async function fixture(routes: FetchRoute[]) {
    const setup = await makeTestApp({
      tempPrefix: "owc-models-",
      agent: "real",
      core: "real",
      settingsEnv: {},
      models: (root, events) => ModelRegistry.load({
        ...paths(root),
        fetchImpl: fetchStub(routes),
        onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
      }),
      providerProfilesRuntime: (models) => ({
        refreshModels: () => models!.refresh({ providers: [
          { provider: "anthropic", interfaceType: "anthropic-messages", apiKey: "sk-ant" },
          { provider: "openai", interfaceType: "openai-chat-completions", baseURL: "https://openai.test" },
        ] }),
      }) as unknown as ProviderProfilesRuntime,
    });
    return { app: setup.app, models: setup.models!, observed: setup.observed };
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
      // videoOutput 与已废弃的 maxOutput 都不能泄漏为 API 合同的一部分（静默忽略，不 400）。
      const caps = { modalities: ["text", "image", "video"], imageOutput: true, thinking: ["adaptive", "disabled"], effort: ["low", "high"], tools: false };
      const updated = await app.inject({ method: "PUT", url: "/api/models/my-custom", payload: { capabilities: { ...caps, videoOutput: true }, maxOutput: 8_000 } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ id: "my-custom", source: "manual", capabilities: caps });
      expect(updated.json()).not.toHaveProperty("capabilities.videoOutput");
      expect(updated.json()).not.toHaveProperty("maxOutput");
      // minimal effort 与 responsesEncryptedReplay 是合法声明并原样持久化
      const replayCaps = { modalities: ["text"], imageOutput: false, thinking: [], effort: ["minimal"], tools: true, responsesEncryptedReplay: true };
      const replay = await app.inject({ method: "PUT", url: "/api/models/replay-model", payload: { provider: "openai", capabilities: replayCaps } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ id: "replay-model", capabilities: expect.objectContaining({ effort: ["minimal"], responsesEncryptedReplay: true }) });
      // 非布尔 responsesEncryptedReplay 拒绝（400），错误信息提及该字段
      const replayBad = await app.inject({ method: "PUT", url: "/api/models/replay-model", payload: { provider: "openai", capabilities: { ...replayCaps, responsesEncryptedReplay: "yes" } } });
      expect(replayBad.statusCode).toBe(400);
      expect(replayBad.json().error).toContain("responsesEncryptedReplay");
      expect((await app.inject({ method: "DELETE", url: "/api/models/nonexistent" })).statusCode).toBe(409);
      expect((await app.inject({ method: "DELETE", url: "/api/models/my-custom" })).statusCode).toBe(204);
      const after = (await app.inject({ method: "GET", url: "/api/models" })).json<CatalogModel[]>();
      expect(after.some((model) => model.id === "my-custom")).toBe(false);
    } finally {
      await app.close();
    }
  });
});

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

async function syncFixture(options: {
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
        capabilities: { modalities: ["text", "image", "video"], imageOutput: true, thinking: [], effort: [], tools: true },
      }],
    };
    const setup = await syncFixture({
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
    const setup = await syncFixture();
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