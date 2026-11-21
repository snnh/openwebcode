/**
 * dsh 模型面：`session/modelCatalog` / `session/selectModel` / `modelSelection` / `pluginInventory/list`。
 * 第二部分用客户端自己的生成 codec（strict schema）parse 我方投影值；未 vendor 时整组跳过。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDshModelBridge, defaultDshSelection, type DshModelSources } from "../src/dsh/model-bridge.js";
import { modelSelectionValue, projectModelCatalog, projectSelectModel, type DshCatalogModel, type DshModelBridge } from "../src/dsh/web-protocol/models.js";
import { projectPluginInventory } from "../src/dsh/web-protocol/plugin-inventory.js";
import { projectSessionControlBaseline, type DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import type { DshPluginInfo } from "../src/dsh/loader.js";
import type { ChatMessage, SessionDetail, SessionMeta } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGINS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins");
const SESSION_CONTROLLER = path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");
const VENDOR_SKIP = existsSync(SESSION_CONTROLLER) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";
const ALL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const THINKING_MODEL: DshCatalogModel = { provider: "deepseek", id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", contextWindow: 128_000, capabilities: { thinking: ["enabled", "disabled"], effort: ["low", "medium", "high"] } };
const PLAIN_MODEL: DshCatalogModel = { provider: "openai", id: "gpt-4.1", contextWindow: 1_000_000, capabilities: { thinking: [], effort: [] } };

function bridge(overrides: Partial<DshModelBridge> = {}): DshModelBridge {
  return {
    providers: () => ["deepseek", "openai"], models: () => [THINKING_MODEL, PLAIN_MODEL],
    defaults: () => ({ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" }),
    sessionDefault: () => ({ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" }),
    ...overrides,
  };
}

/** 投影出 catalog 里的模型行（按 provider/model 定位）。 */
function rowOf(catalog: Record<string, unknown>, provider: string, model: string): Record<string, unknown> {
  const groups = catalog.groups as Array<{ id: string; models: Array<Record<string, unknown>> }>;
  const row = groups.find((item) => item.id === provider)?.models.find((item) => item.id === model); expect(row, `缺少模型 ${provider}/${model}`).toBeDefined();
  return row!;
}

describe("session/modelCatalog 投影", () => {
  it("按服务商分组、展示名缺省回退 id，并给出部署默认/可路由服务商；reasoning 只在模型确实支持思考时出现", () => {
    const catalog = projectModelCatalog(bridge()); expect([catalog.default, catalog.routableProviders, catalog.failures]).toEqual([
      { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" }, ["deepseek", "openai"], [],
    ]);
    expect(catalog.groups as unknown[]).toHaveLength(2); expect(rowOf(catalog, "deepseek", "deepseek-reasoner").name).toBe("DeepSeek Reasoner"); expect(rowOf(catalog, "openai", "gpt-4.1").name).toBe("gpt-4.1");
    // 档位来自 profile，默认档位来自部署默认；纯文本模型不带 reasoning（不编造档位）
    expect(rowOf(catalog, "deepseek", "deepseek-reasoner").reasoning)
      .toEqual({ efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }], defaultEffort: "medium" });
    expect(rowOf(catalog, "openai", "gpt-4.1").reasoning).toBeUndefined();
    // 未声明档位 = 全开（与 REST 口径一致）
    const undeclared = projectModelCatalog(bridge({ models: () => [{ provider: "kimi", id: "k3", capabilities: { thinking: ["enabled"], effort: [] } }], defaults: () => undefined }));
    expect((rowOf(undeclared, "kimi", "k3").reasoning as { efforts: Array<{ id: string }> }).efforts.map((item) => item.id)).toEqual(ALL_EFFORTS);
  });

  it("降级口径：无默认模型回退首个可路由模型、目录为空如实留空、provider 未配置仍展示但不进 routable", () => {
    expect(projectModelCatalog(bridge({ defaults: () => undefined })).default).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    const empty = projectModelCatalog({ providers: () => [], models: () => [], defaults: () => undefined }); expect([empty.default, empty.groups]).toEqual([{ provider: "", model: "" }, []]);
    const unwired = projectModelCatalog(bridge({ providers: () => ["openai"] })); expect([unwired.routableProviders, (unwired.groups as unknown[]).length]).toEqual([["openai"], 2]);
  });

  it("modelSelection 投影：effort → reasoningEffort；无 effort 不带该键；provider/model 为空（旧数据）时 next = null", () => {
    expect(modelSelectionValue({ provider: "deepseek", model: "deepseek-reasoner", effort: "high" }))
      .toEqual({ lastUsed: null, next: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } });
    expect(modelSelectionValue({ provider: "openai", model: "gpt-4.1" })).toEqual({ lastUsed: null, next: { provider: "openai", model: "gpt-4.1" } }); expect(modelSelectionValue({ provider: "", model: "" })).toEqual({ lastUsed: null, next: null });
  });
});

describe("session/selectModel", () => {
  function selectDeps(overrides: Partial<Parameters<typeof projectSelectModel>[0]> = {}) {
    const applied: unknown[][] = [];
    const base = { providers: () => ["deepseek", "openai"], models: () => [THINKING_MODEL, PLAIN_MODEL], selectionOf: async () => ({ provider: "openai", model: "gpt-4.1" }), isRunning: () => false,
      apply: async (sessionId: string, selection: unknown) => { applied.push([sessionId, selection]); }, ...overrides };
    return { deps: base, applied };
  }
  it("合法选择落盘并回显；模型未声明档位时 effort 放行（未声明 = 全开）", async () => {
    const high = selectDeps(); expect(await projectSelectModel(high.deps, { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } }))
      .toEqual({ value: { selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } } });
    expect(high.applied).toEqual([["s1", { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" }]]);
    const open = selectDeps({ models: () => [PLAIN_MODEL] }); expect(await projectSelectModel(open.deps, { request: { sessionId: "s1", provider: "openai", model: "gpt-4.1", reasoningEffort: "ultra" } }))
      .toEqual({ value: { selected: { provider: "openai", model: "gpt-4.1", reasoningEffort: "ultra" } } });
  });

  it("失败分支各给明确 wire 错误且不落盘（会话不存在/运行中/服务商未配置/模型不在目录/档位超声明/缺 sessionId）", async () => {
    const cases: Array<[string, Partial<Parameters<typeof projectSelectModel>[0]>, Record<string, unknown>]> = [
      ["session/not-found", { selectionOf: async () => undefined }, { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner" } }],
      ["session/agent-busy", { isRunning: () => true }, { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner" } }],
      ["session/model-unavailable", {}, { request: { sessionId: "s1", provider: "anthropic", model: "claude" } }],
      ["session/model-unavailable", {}, { request: { sessionId: "s1", provider: "deepseek", model: "不存在" } }],
      ["gateway/bad-request", {}, { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "ultra" } }],
      ["gateway/bad-request", {}, { request: { provider: "deepseek", model: "deepseek-reasoner" } }],
    ];
    for (const [code, overrides, args] of cases) {
      const { deps: d, applied } = selectDeps(overrides);
      const result = await projectSelectModel(d, args); expect("error" in result && result.error.code, JSON.stringify(args)).toBe(code); expect(applied, JSON.stringify(args)).toEqual([]);
    }
  });
});

describe("createDshModelBridge（owc 事实 → 桥）", () => {
  function sources(overrides: { defaultModel?: { provider: string; model: string } | null; defaultEffort?: string; routable?: string[]; models?: unknown[] } = {}): DshModelSources {
    const profile = { id: "m1", provider: "deepseek", contextWindow: 1_000, capabilities: { modalities: [], imageOutput: false, thinking: [], effort: ["low", "medium", "high"], tools: true } };
    const models = (overrides.models ?? [{ ...profile, source: "manual" }]) as never[];
    return {
      providers: { list: () => overrides.routable ?? ["deepseek"] }, models: { list: () => models, get: () => profile as never },
      settings: { effective: () => ({ ...(overrides.defaultModel === null ? {} : { defaultModel: overrides.defaultModel ?? { provider: "deepseek", model: "m1" } }), ...(overrides.defaultEffort === undefined ? {} : { defaultEffort: overrides.defaultEffort as never }) }) },
    };
  }
  it("默认选择来自 settings.defaultModel，defaultEffort 过能力白名单才带上；未配置 defaultModel 时如实 undefined", () => {
    expect(defaultDshSelection(sources({ defaultEffort: "medium" }))).toEqual({ provider: "deepseek", model: "m1", reasoningEffort: "medium" });
    // 模型不支持该力度：静默不带 effort（与 REST 新建会话同口径）
    expect(defaultDshSelection(sources({ defaultEffort: "ultra" }))).toEqual({ provider: "deepseek", model: "m1" });
    const wired = createDshModelBridge(sources({ defaultModel: null })); expect([defaultDshSelection(sources({ defaultModel: null })), wired.defaults()]).toEqual([undefined, undefined]);
    // catalog default 的 schema 要求 string 字段 → 无默认时回退首个可路由模型；建会话同样回退
    expect([projectModelCatalog(wired).default, wired.sessionDefault()]).toEqual([{ provider: "deepseek", model: "m1" }, { provider: "deepseek", model: "m1" }]);
  });

  it("会话默认：默认模型的服务商不可路由时回落首个可路由模型；无任何可路由模型时不写 provider/model", () => {
    // settings.defaultModel 指向 deepseek，但只有 openai 配了凭据 → 不能拿它建会话（REST 会 400）
    const wired = createDshModelBridge(sources({ routable: ["openai"] })); expect([defaultDshSelection(sources({ routable: ["openai"] })), wired.sessionDefault()]).toEqual([{ provider: "deepseek", model: "m1" }, { provider: "deepseek", model: "m1" }]);
    const bare = createDshModelBridge({ providers: { list: () => [] }, models: { list: () => [], get: () => ({ capabilities: { effort: [] } }) as never }, settings: { effective: () => ({}) } });
    expect([bare.sessionDefault(), projectModelCatalog(bare).default]).toEqual([undefined, { provider: "", model: "" }]);
  });
});

describe("pluginInventory/list 与端点注册", () => {
function plugin(overrides: Partial<DshPluginInfo> & { id: string }): DshPluginInfo {
    return { name: "demo-plugin", version: "1.0.0", description: "", directory: "/data/dsh-plugins/demo", enabled: true, status: "running", dependencies: {}, ...overrides } as DshPluginInfo;
  }
  it("插件状态映射为 fiber 相位（停用为 null）且不宣称可管理", () => {
    const snapshot = projectPluginInventory([
      plugin({ id: "@demo/plugin" }), plugin({ id: "@demo/slow", status: "missing-services" }),
      plugin({ id: "@demo/broken", status: "error" }), plugin({ id: "@demo/old", status: "incompatible" }),
      plugin({ id: "@demo/off", enabled: false, status: "disabled" }),
    ]);
    expect(snapshot).toEqual({
      managementAvailable: false,
      entries: [
        { entryId: "@demo/plugin", moduleName: "demo-plugin", enabled: true, fiberPhase: "active" },
        { entryId: "@demo/slow", moduleName: "demo-plugin", enabled: true, fiberPhase: "pending" },
        { entryId: "@demo/broken", moduleName: "demo-plugin", enabled: true, fiberPhase: "failed" },
        { entryId: "@demo/old", moduleName: "demo-plugin", enabled: true, fiberPhase: "failed" },
        { entryId: "@demo/off", moduleName: "demo-plugin", enabled: false, fiberPhase: null },
      ],
    });
  });

  it("unary 端点按依赖面注册：带模型/插件面才下发，否则客户端收到 method-unavailable 而不是假数据", async () => {
    const { buildUnaryHandlers } = await import("../src/dsh/web-protocol/streams.js");
    const base = { projection: {} as DshProjectionDeps, events: {} as never, home: "/home", respondPermission: async () => undefined, respondInteraction: async () => undefined, logger: { warn: () => undefined } };
    const full = buildUnaryHandlers({ ...base, settings: { profiles: () => [] }, pluginInventory: () => [],
      models: { catalog: () => ({}), select: async () => ({ value: { selected: { provider: "p", model: "m" } } }), providers: () => ["p"] } } as never);
    expect([...full.keys()]).toEqual(expect.arrayContaining(["session/modelCatalog", "session/selectModel", "pluginInventory/list"]));
    const bare = buildUnaryHandlers(base as never); expect([...bare.keys()].filter((endpoint) => ["session/modelCatalog", "session/selectModel", "pluginInventory/list"].includes(endpoint))).toEqual([]);
    expect([...bare.keys()]).toEqual(expect.arrayContaining(["session/list", "session/prompt"]));
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("契约校验：vendor 生成 codec（strict schema）", () => {
  async function loadDescriptors() {
    const module = await import(SESSION_CONTROLLER) as { default?: { descriptors?: Array<{ namespace: string; method: string; result: { create(): { parse(value: unknown): unknown } }; parameters?: Array<{ name: string; codec: { create(): { parse(value: unknown): unknown } } }> }> } };
    return new Map((module.default?.descriptors ?? []).map((item) => [`${item.namespace}/${item.method}`, item]));
  }
  it("modelCatalog/selectModel（含入参 request shape）与含 modelSelection 的 control 基线都通过 strict schema", async () => {
    const descriptors = await loadDescriptors();
    const catalogDescriptor = descriptors.get("session/modelCatalog"); expect(catalogDescriptor, "vendor 缺少 session/modelCatalog").toBeDefined(); expect(catalogDescriptor?.result.create().parse(projectModelCatalog(bridge()))).toBeDefined();
    const selectDescriptor = descriptors.get("session/selectModel"); expect(selectDescriptor, "vendor 缺少 session/selectModel").toBeDefined();
    expect(selectDescriptor?.result.create().parse({ selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } })).toBeDefined();
    // 入参同样要过客户端的 request schema：我方消费的 shape 必须与 wire 契约一致
    const requestCodec = selectDescriptor?.parameters?.[0]?.codec; expect(requestCodec, "session/selectModel 应有单个 request 参数").toBeDefined();
    expect(requestCodec?.create().parse({ sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" })).toBeDefined();
    const meta = { id: "s1", cwd: "/work/proj", provider: "deepseek", model: "deepseek-reasoner", effort: "high", title: "会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as SessionMeta;
    const messages: ChatMessage[] = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:00:01.000Z" }];
    const withMessages = { ...meta, messages, hasMoreMessages: false } as SessionDetail;
    const projection = { sessions: { list: async () => [meta], create: async () => meta, getMeta: async () => meta, updateConfig: async () => meta, get: async () => withMessages, getTail: async () => withMessages }, agent: {}, defaultCwd: "/work" } as unknown as DshProjectionDeps;
    const baseline = await projectSessionControlBaseline(projection);
    const value = "value" in baseline ? baseline.value : undefined; expect(value).toBeDefined();
    const controlDescriptor = descriptors.get("session/control"); expect(controlDescriptor, "vendor 缺少 session/control").toBeDefined(); expect(controlDescriptor?.result.create().parse(value)).toBeDefined();
  });
});
