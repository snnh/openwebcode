import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService, ProviderProfilesValidationError } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { createProfileSearchProvider, createProfileWebFetchProvider } from "../src/web-tools.js";
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
    await s.service.upsertWeb(undefined, { id: "Baidu", provider: "baidu", apiKey: "baidu-key", searchEdition: "turbo", complianceScene: "auto" });
    await s.service.selectWeb("search", "Brave");
    await s.service.selectWeb("fetch", "Internal Reader");
    // 请求声明的 capabilities 经内建能力表归一化（jina/tavily 兼具双能力，brave 仅 search）
    expect(s.service.view()).toMatchObject({ activeWeb: { search: "Brave", fetch: "Internal Reader" }, webProviders: [
      { id: "Jina", capabilities: ["search", "fetch"] }, { id: "Brave", capabilities: ["search"] },
      { id: "Tavily", capabilities: ["search", "fetch"] }, { id: "Internal Reader", capabilities: ["fetch"] },
      { id: "Baidu", capabilities: ["search"], searchEdition: "turbo", complianceScene: "auto" },
    ] });
    await expect(s.service.selectWeb("fetch", "Brave")).rejects.toThrow(/未声明 fetch/);
  });
  it("百度 AI 搜索：请求体按千帆 /v2/ai_search/web_search 协议组装，references 归一化为结果", async () => {
    const s = await fixture();
    await s.service.upsertWeb(undefined, { id: "Baidu", provider: "baidu", apiKey: "baidu-key", searchEdition: "turbo", complianceScene: "abroad" });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ references: [
        { title: "标题一", url: "https://example.test/a", content: "摘要\u0004含控制字符", type: "web" },
        { title: "标题二", url: "https://example.test/b", snippet: "优先使用 snippet", content: "备用 content" },
        { title: "", url: "https://example.test/c", content: "缺标题丢弃" },
      ], request_id: "req-1" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = createProfileSearchProvider(s.service.selectedWebProfiles().search, fetchImpl);
    expect(provider?.name).toBe("Baidu");
    const results = await provider!.search("北京天气", 3);
    expect(results).toEqual([
      { title: "标题一", url: "https://example.test/a", snippet: "摘要 含控制字符" },
      { title: "标题二", url: "https://example.test/b", snippet: "优先使用 snippet" },
    ]);
    expect(calls[0]?.url).toBe("https://qianfan.baidubce.com/v2/ai_search/web_search");
    expect(calls[0]?.init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer baidu-key" } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messages: [{ role: "user", content: "北京天气" }],
      search_source: "baidu_search_v2",
      edition: "turbo",
      compliance_scene: "abroad",
      resource_type_filter: [{ type: "web", top_k: 3 }],
    });
    // standard / pro 版按文档忽略 compliance_scene，不应发送该字段
    const standard = createProfileSearchProvider({ id: "Baidu Standard", provider: "baidu", capabilities: ["search"], apiKey: "baidu-key" }, fetchImpl);
    await standard!.search("标准版查询", 1);
    expect(JSON.parse(String(calls[1]?.init.body))).not.toHaveProperty("compliance_scene");
    const pro = createProfileSearchProvider({ id: "Baidu Pro", provider: "baidu", capabilities: ["search"], apiKey: "baidu-key", searchEdition: "pro", complianceScene: "abroad" }, fetchImpl);
    await pro!.search("旗舰版查询", 1);
    const proBody = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    expect(proBody).toMatchObject({ edition: "pro", resource_type_filter: [{ type: "web", top_k: 1 }] });
    expect(proBody).not.toHaveProperty("compliance_scene");
    await s.service.upsertWeb(undefined, { id: "Baidu Pro", provider: "baidu", apiKey: "baidu-key", searchEdition: "pro" });
    expect(s.service.view().webProviders.find((item) => item.id === "Baidu Pro")?.searchEdition).toBe("pro");
  });
  it("Web Fetch 新渠道：Exa Contents / ScrapingBee / ScraperAPI / ZenRows 的请求与正文解析", async () => {
    const s = await fixture();
    await s.service.upsertWeb(undefined, { id: "Exa", provider: "exa", apiKey: "exa-key" });
    await s.service.upsertWeb(undefined, { id: "ScrapingBee", provider: "scrapingbee", apiKey: "bee-key" });
    await s.service.upsertWeb(undefined, { id: "ScraperAPI", provider: "scraperapi", apiKey: "sa-key" });
    await s.service.upsertWeb(undefined, { id: "ZenRows", provider: "zenrows", apiKey: "zr-key" });
    const profiles = s.service.view().webProviders;
    expect(profiles.find((item) => item.id === "Exa")?.capabilities).toEqual(["search", "fetch"]);
    expect(profiles.find((item) => item.id === "ScrapingBee")?.capabilities).toEqual(["fetch"]);
    expect(profiles.find((item) => item.id === "ScraperAPI")?.capabilities).toEqual(["fetch"]);
    expect(profiles.find((item) => item.id === "ZenRows")?.capabilities).toEqual(["fetch"]);

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("https://api.exa.ai/contents")) {
        return new Response(JSON.stringify({ results: [{ text: "# Exa 正文", url: "https://example.test/page" }], statuses: [{ status: "success" }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(`正文 from ${new URL(url).hostname}`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }) as typeof fetch;

    const fetchWith = async (id: string) => {
      await s.service.selectWeb("fetch", id);
      return createProfileWebFetchProvider(s.service.selectedWebProfiles().fetch, fetchImpl)!;
    };

    const exa = await fetchWith("Exa");
    const exaOut = await exa.fetchUrl("https://example.test/page");
    expect(exaOut).toMatchObject({ finalUrl: "https://example.test/page", text: "# Exa 正文", contentType: "text/markdown; charset=utf-8" });
    const exaCall = calls.find((call) => call.url === "https://api.exa.ai/contents")!;
    expect(exaCall.init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer exa-key" } });
    expect(JSON.parse(String(exaCall.init.body))).toEqual({ ids: ["https://example.test/page"], text: { maxCharacters: 20_000 }, maxAgeHours: 0 });

    const bee = await fetchWith("ScrapingBee");
    expect((await bee.fetchUrl("https://example.test/page")).text).toBe("正文 from app.scrapingbee.com");
    const beeCall = calls.find((call) => call.url.startsWith("https://app.scrapingbee.com/api/v1?"))!;
    expect(beeCall.url).toBe("https://app.scrapingbee.com/api/v1?url=https%3A%2F%2Fexample.test%2Fpage&return_page_markdown=true&render_js=true");
    expect(beeCall.init.headers).toMatchObject({ Authorization: "Bearer bee-key" });

    const sa = await fetchWith("ScraperAPI");
    expect((await sa.fetchUrl("https://example.test/page")).text).toBe("正文 from api.scraperapi.com");
    const saCall = calls.find((call) => call.url.startsWith("https://api.scraperapi.com/?"))!;
    expect(saCall.url).toBe("https://api.scraperapi.com/?api_key=sa-key&url=https%3A%2F%2Fexample.test%2Fpage&output_format=markdown&render=true");
    expect(saCall.init.headers).not.toHaveProperty("Authorization");

    const zr = await fetchWith("ZenRows");
    expect((await zr.fetchUrl("https://example.test/page")).text).toBe("正文 from api.zenrows.com");
    const zrCall = calls.find((call) => call.url.startsWith("https://api.zenrows.com/v1/?"))!;
    expect(zrCall.url).toBe("https://api.zenrows.com/v1/?apikey=zr-key&url=https%3A%2F%2Fexample.test%2Fpage&response_type=markdown&mode=auto");
    expect(zrCall.init.headers).not.toHaveProperty("Authorization");
  });
  it("非法输入拒绝：custom 端点缺参，旧版档案文档不覆盖原文件", async () => {
    const s = await fixture();
    await expect(s.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["search"] })).rejects.toThrow(/Search Base URL/);
    await expect(s.service.upsertWeb(undefined, { id: "custom", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/plain" })).rejects.toThrow(/\{url\}/);
    await expect(s.service.upsertWeb(undefined, { id: "Baidu", provider: "baidu", capabilities: ["search"] })).rejects.toThrow(/API Key/);
    await expect(s.service.upsertWeb(undefined, { id: "ScraperAPI", provider: "scraperapi", capabilities: ["fetch"] })).rejects.toThrow(/API Key/);
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