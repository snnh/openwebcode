import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService, ProviderProfilesValidationError } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function fixture() {
  const root = await tempRoot("owc-provider-profiles-");
  const filePath = path.join(root, "provider-profiles.json");
  return { root, filePath, service: await ProviderProfilesService.load({ filePath }) };
}

describe("ProviderProfilesService", () => {
  it("stores multiple named model providers, masks secrets, and preserves disabled drafts", async () => {
    const setup = await fixture();
    await setup.service.upsertModel(undefined, {
      id: "OpenAI Main",
      enabled: true,
      interfaceType: "openai-chat-completions",
      baseURL: "https://api.openai.test/v1",
      apiKey: "secret-openai-key-1234",
    });
    await setup.service.upsertModel(undefined, {
      id: "备用 Claude",
      enabled: false,
      interfaceType: "anthropic-messages",
    });

    const view = setup.service.view();
    expect(view.modelProviders).toHaveLength(2);
    expect(view.modelProviders[0]).toMatchObject({ id: "OpenAI Main", enabled: true, hasApiKey: true, maskedApiKey: "secret-…1234" });
    expect(JSON.stringify(view)).not.toContain("secret-openai-key-1234");
    await expect(setup.service.upsertModel("备用 Claude", { enabled: true })).rejects.toBeInstanceOf(ProviderProfilesValidationError);

    const persisted = await readFile(setup.filePath, "utf8");
    expect(persisted).toContain("secret-openai-key-1234");
    const restored = await ProviderProfilesService.load({ filePath: setup.filePath });
    expect(restored.modelProfiles().map((item) => item.id)).toEqual(["OpenAI Main", "备用 Claude"]);
  });

  it("derives built-in web capabilities and selects independent search/fetch profiles", async () => {
    const setup = await fixture();
    await setup.service.upsertWeb(undefined, { id: "Jina", provider: "jina", capabilities: ["fetch"], apiKey: "jina-key" });
    await setup.service.upsertWeb(undefined, { id: "Brave", provider: "brave", capabilities: ["fetch"], apiKey: "brave-key" });
    await setup.service.upsertWeb(undefined, { id: "Tavily", provider: "tavily", capabilities: ["search"], apiKey: "tavily-key" });
    await setup.service.upsertWeb(undefined, {
      id: "Internal Reader",
      provider: "custom",
      capabilities: ["fetch"],
      fetchBaseURL: "https://reader.test/?url={url}",
    });
    await setup.service.selectWeb("search", "Brave");
    await setup.service.selectWeb("fetch", "Internal Reader");

    expect(setup.service.view()).toMatchObject({
      activeWeb: { search: "Brave", fetch: "Internal Reader" },
      webProviders: [
        { id: "Jina", capabilities: ["search", "fetch"] },
        { id: "Brave", capabilities: ["search"] },
        { id: "Tavily", capabilities: ["search", "fetch"] },
        { id: "Internal Reader", capabilities: ["fetch"] },
      ],
    });
    await expect(setup.service.selectWeb("fetch", "Brave")).rejects.toThrow(/未声明 fetch/);
  });

  it("requires custom endpoints for every declared capability", async () => {
    const setup = await fixture();
    await expect(setup.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["search"] })).rejects.toThrow(/Search Base URL/);
    await expect(setup.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/plain" })).rejects.toThrow(/{url}/);
  });

  it("validates, persists, and clears extraBody custom request fields", async () => {
    const setup = await fixture();
    await setup.service.upsertModel(undefined, {
      id: "qwen",
      enabled: true,
      interfaceType: "openai-chat-completions",
      baseURL: "https://qwen.test/v1",
      extraBody: { temperature: 0.7, max_tokens: 8192 },
    });
    expect(setup.service.view().modelProviders[0]?.extraBody).toEqual({ temperature: 0.7, max_tokens: 8192 });
    const persisted = JSON.parse(await readFile(setup.filePath, "utf8")) as { models: Array<{ extraBody?: unknown }> };
    expect(persisted.models[0]?.extraBody).toEqual({ temperature: 0.7, max_tokens: 8192 });

    await expect(setup.service.upsertModel("qwen", { extraBody: [1, 2] })).rejects.toThrow(/JSON 对象/);
    await expect(setup.service.upsertModel("qwen", { extraBody: { messages: [] } })).rejects.toThrow(/核心字段/);
    await expect(setup.service.upsertModel("qwen", { extraBody: { stream: false } })).rejects.toThrow(/核心字段/);

    await setup.service.upsertModel("qwen", { extraBody: null });
    expect(setup.service.view().modelProviders[0]?.extraBody).toBeUndefined();
  });

  it("rejects obsolete or malformed profile documents instead of replacing them", async () => {
    const setup = await fixture();
    await writeFile(setup.filePath, JSON.stringify({ anthropic: { apiKey: "old" }, search: { provider: "brave" } }));
    await expect(ProviderProfilesService.load({ filePath: setup.filePath })).rejects.toThrow(/格式无效/);
    expect(await readFile(setup.filePath, "utf8")).toContain("anthropic");
  });

  it("hot-registers enabled model providers, refreshes their models, and removes disabled cache entries", async () => {
    const setup = await fixture();
    const providers = new ProviderRegistry();
    const searchNames: Array<string | undefined> = [];
    const fetchNames: Array<string | undefined> = [];
    const agent = {
      setSearchProvider(value: { name: string } | undefined) { searchNames.push(value?.name); },
      setWebFetchProvider(value: { name: string } | undefined) { fetchNames.push(value?.name); },
    } as unknown as AgentRunner;
    const models = await ModelRegistry.load({
      snapshotPath: path.join(setup.root, "models.json"),
      manualPath: path.join(setup.root, "models.manual.json"),
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "same-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    const runtime = new ProviderProfilesRuntime(setup.service, providers, agent, models, new EventBus());
    runtime.start();
    try {
      await setup.service.upsertModel(undefined, {
        id: "本地服务",
        enabled: true,
        interfaceType: "openai-chat-completions",
        baseURL: "https://local.test/v1",
      });
      expect(providers.list()).toEqual(["本地服务"]);
      await vi.waitFor(() => expect(models.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "same-model", provider: "本地服务", source: "api" }),
      ])));

      await setup.service.upsertModel("本地服务", { enabled: false });
      expect(providers.list()).toEqual([]);
      await vi.waitFor(() => expect(models.list().some((model) => model.id === "same-model" && model.provider === "本地服务")).toBe(false));

      await setup.service.upsertWeb(undefined, { id: "Jina", provider: "jina", capabilities: ["search"] });
      await setup.service.selectWeb("search", "Jina");
      await setup.service.selectWeb("fetch", "Jina");
      expect(searchNames.at(-1)).toBe("Jina");
      expect(fetchNames.at(-1)).toBe("Jina");
    } finally {
      runtime.stop();
    }
  });
});
