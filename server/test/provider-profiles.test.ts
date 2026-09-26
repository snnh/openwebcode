import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService, ProviderProfilesValidationError } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { tempRoot } from "./helpers/temp-roots.js";
import { makeTestApp } from "./helpers/test-app.js";

async function fixture() {
  const root = await tempRoot("owc-provider-profiles-");
  const filePath = path.join(root, "provider-profiles.json");
  return { root, filePath, service: await ProviderProfilesService.load({ filePath }) };
}
describe("ProviderProfilesService", () => {
  it("模型档案读写：多档案存储、密钥掩码、持久化重载与 extraBody 往返", async () => {
    const s = await fixture();
    await s.service.upsertModel(undefined, { id: "OpenAI Main", enabled: true, interfaceType: "openai-chat-completions", baseURL: "https://api.openai.test/v1", apiKey: "secret-openai-key-1234", extraBody: { temperature: 0.7, max_tokens: 8192 } });
    await s.service.upsertModel(undefined, { id: "备用 Claude", enabled: false, interfaceType: "anthropic-messages" }); // 禁用草稿：缺 URL/Key 也可存，但不允许被启用
    expect(s.service.view().modelProviders).toHaveLength(2);
    expect(s.service.view().modelProviders[0]).toMatchObject({ id: "OpenAI Main", enabled: true, hasApiKey: true, maskedApiKey: "secret-…1234", extraBody: { temperature: 0.7, max_tokens: 8192 } });
    expect(JSON.stringify(s.service.view())).not.toContain("secret-openai-key-1234"); // 视图掩码
    await expect(s.service.upsertModel("备用 Claude", { enabled: true })).rejects.toBeInstanceOf(ProviderProfilesValidationError);
    const persisted = JSON.parse(await readFile(s.filePath, "utf8")) as { models: Array<{ extraBody?: unknown }> };
    expect(JSON.stringify(persisted)).toContain("secret-openai-key-1234"); // 落盘不掩码
    expect(persisted.models[0]?.extraBody).toEqual({ temperature: 0.7, max_tokens: 8192 });
    expect((await ProviderProfilesService.load({ filePath: s.filePath })).modelProfiles().map((item) => item.id)).toEqual(["OpenAI Main", "备用 Claude"]);
    await expect(s.service.upsertModel("OpenAI Main", { extraBody: [1, 2] })).rejects.toThrow(/JSON 对象/);
    await expect(s.service.upsertModel("OpenAI Main", { extraBody: { stream: false } })).rejects.toThrow(/核心字段/);
    await s.service.upsertModel("OpenAI Main", { extraBody: null });
    expect(s.service.view().modelProviders[0]?.extraBody).toBeUndefined();
  });
  it("web 档案：内建能力派生、search/fetch 独立选择、未声明能力拒绝", async () => {
    const s = await fixture();
    await s.service.upsertWeb(undefined, { id: "Jina", provider: "jina", capabilities: ["fetch"], apiKey: "jina-key" });
    await s.service.upsertWeb(undefined, { id: "Brave", provider: "brave", capabilities: ["fetch"], apiKey: "brave-key" });
    await s.service.upsertWeb(undefined, { id: "Tavily", provider: "tavily", capabilities: ["search"], apiKey: "tavily-key" });
    await s.service.upsertWeb(undefined, { id: "Internal Reader", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/?url={url}" });
    await s.service.selectWeb("search", "Brave");
    await s.service.selectWeb("fetch", "Internal Reader");
    // 请求声明的 capabilities 经内建能力表归一化（jina/tavily 兼具双能力，brave 仅 search）
    expect(s.service.view()).toMatchObject({ activeWeb: { search: "Brave", fetch: "Internal Reader" }, webProviders: [
      { id: "Jina", capabilities: ["search", "fetch"] }, { id: "Brave", capabilities: ["search"] },
      { id: "Tavily", capabilities: ["search", "fetch"] }, { id: "Internal Reader", capabilities: ["fetch"] },
    ] });
    await expect(s.service.selectWeb("fetch", "Brave")).rejects.toThrow(/未声明 fetch/);
  });
  it("非法输入拒绝：custom 端点缺参，旧版档案文档不覆盖原文件", async () => {
    const s = await fixture();
    await expect(s.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["search"] })).rejects.toThrow(/Search Base URL/);
    await expect(s.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/plain" })).rejects.toThrow(/\{url\}/);
    await writeFile(s.filePath, JSON.stringify({ anthropic: { apiKey: "old" }, search: { provider: "brave" } }));
    await expect(ProviderProfilesService.load({ filePath: s.filePath })).rejects.toThrow(/格式无效/);
    expect(await readFile(s.filePath, "utf8")).toContain("anthropic");
  });
  it("热注册：enabled 档案入册并把模型投影进目录，禁用后移除，联网组件随之接线", async () => {
    const s = await fixture();
    const providers = new ProviderRegistry();
    const wired: string[] = [];
    const agent = {
      setSearchProvider: (value?: { name: string }) => wired.push(`search:${value?.name}`),
      setWebFetchProvider: (value?: { name: string }) => wired.push(`fetch:${value?.name}`),
    } as unknown as AgentRunner;
    const models = await ModelRegistry.load({
      snapshotPath: path.join(s.root, "models.json"),
      manualPath: path.join(s.root, "models.manual.json"),
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "same-model" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    const runtime = new ProviderProfilesRuntime(s.service, providers, agent, models, new EventBus());
    runtime.start();
    try {
      await s.service.upsertModel(undefined, { id: "本地服务", enabled: true, interfaceType: "openai-chat-completions", baseURL: "https://local.test/v1" });
      expect(providers.list()).toEqual(["本地服务"]);
      await vi.waitFor(() => expect(models.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "same-model", provider: "本地服务", source: "api" })])));
      await s.service.upsertModel("本地服务", { enabled: false });
      expect(providers.list()).toEqual([]);
      await vi.waitFor(() => expect(models.list().some((model) => model.provider === "本地服务")).toBe(false));
      await s.service.upsertWeb(undefined, { id: "Jina", provider: "jina", capabilities: ["search"] });
      await s.service.selectWeb("search", "Jina");
      await s.service.selectWeb("fetch", "Jina");
      expect(wired).toContain("search:Jina");
      expect(wired).toContain("fetch:Jina");
    } finally { runtime.stop(); }
  });
});
describe("POST /api/provider-profiles/test", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const openaiBody = { id: "测试服务", interfaceType: "openai-chat-completions", baseURL: "https://api.example.test/v1", apiKey: "sk-test" };
  const anthropicBody = { id: "Claude", interfaceType: "anthropic-messages", apiKey: "sk-ant" };
  const connectionApp = async () => (await makeTestApp({ tempPrefix: "owc-provider-test-", providerProfiles: true })).app;
  const stubFetchStatus = (status: number) => {
    const handler = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", handler);
    return handler;
  };
  const post = (app: Awaited<ReturnType<typeof connectionApp>>, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/provider-profiles/test", payload });
  it("两家接口的成功探测形状（URL/鉴权头/不跟重定向）与请求体校验 400", async () => {
    const app = await connectionApp();
    try {
      const openai = stubFetchStatus(200);
      const ok = await post(app, openaiBody);
      expect([ok.statusCode, ok.json()]).toMatchObject([200, { ok: true, latencyMs: expect.any(Number) }]);
      const [url, init] = openai.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.test/v1/models");
      expect([(init.headers as Record<string, string>).authorization, init.redirect]).toEqual(["Bearer sk-test", "manual"]);
      const anthropic = stubFetchStatus(200); // anthropic 走免费的 GET /v1/models?limit=1，缺省官方地址
      const anth = await post(app, anthropicBody);
      expect([anth.statusCode, anth.json()]).toMatchObject([200, { ok: true }]);
      const [anthUrl, anthInit] = anthropic.mock.calls[0] as [string, RequestInit];
      expect(anthUrl).toBe("https://api.anthropic.com/v1/models?limit=1");
      expect(anthInit.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
      const badInterface = await post(app, { id: "坏配置", interfaceType: "graphql" }); // 校验复用 provider-profiles 口径
      const missingKey = await post(app, { id: "Claude", interfaceType: "anthropic-messages" });
      expect(badInterface.statusCode).toBe(400);
      expect(badInterface.json()).toMatchObject({ error: expect.stringContaining("接口类型") });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json()).toMatchObject({ error: expect.stringContaining("API Key") });
    } finally { await app.close(); }
  });
  type ProbeJson = { ok: boolean; error?: string; note?: string };
  const timeout = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out", "TimeoutError"); }));
  const networkError = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  const probes: Array<[string, () => void, Record<string, unknown>]> = [
    ["401 认证失败", () => stubFetchStatus(401), { ok: false, error: expect.stringContaining("认证失败") }],
    ["403 提示检查 API Key", () => stubFetchStatus(403), { ok: false, error: expect.stringContaining("API Key") }],
    ["404 提示检查 Base URL", () => stubFetchStatus(404), { ok: false, error: expect.stringContaining("Base URL") }],
    ["429 服务可达但限流", () => stubFetchStatus(429), { ok: true, note: expect.stringContaining("429") }],
    ["3xx 不自动跟随", () => stubFetchStatus(302), { ok: false, error: expect.stringContaining("重定向") }],
    ["超时", timeout, { ok: false, error: expect.stringContaining("超时") }],
    ["网络错误", networkError, { ok: false, error: expect.stringContaining("无法连接") }],
  ];
  it.each(probes)("探测结果分类：%s", async (_name, stub, expected) => {
    const app = await connectionApp();
    try { stub(); expect((await post(app, openaiBody)).json<ProbeJson>()).toMatchObject(expected); } finally { await app.close(); }
  });
});