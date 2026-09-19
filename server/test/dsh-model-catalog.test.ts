/**
 * dsh 模型面单测（M4 续）：`session/modelCatalog` / `session/selectModel` / `modelSelection` 投影
 * / `pluginInventory/list`。
 *
 * 第二部分是**契约校验**：本地已 vendor dsh UI（`server/assets/dsh-web/`，gitignored）时，
 * 用 dsh 客户端自己的生成 codec（zod strict schema）parse 我方投影值——「客户端一定接受」的直接证据；
 * 未 vendor 时跳过（CI 无网络也能跑门禁）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDshModelBridge, defaultDshSelection, type DshModelSources } from "../src/dsh/model-bridge.js";
import {
  modelSelectionValue,
  projectModelCatalog,
  projectSelectModel,
  type DshCatalogModel,
  type DshModelBridge,
} from "../src/dsh/web-protocol/models.js";
import { projectPluginInventory } from "../src/dsh/web-protocol/plugin-inventory.js";
import { projectSessionControlBaseline, type DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import type { DshPluginInfo } from "../src/dsh/loader.js";
import type { ChatMessage, SessionDetail, SessionMeta } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGINS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins");
const SESSION_CONTROLLER = path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");
const VENDOR_SKIP = existsSync(SESSION_CONTROLLER) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

const THINKING_MODEL: DshCatalogModel = {
  provider: "deepseek",
  id: "deepseek-reasoner",
  displayName: "DeepSeek Reasoner",
  contextWindow: 128_000,
  capabilities: { thinking: ["enabled", "disabled"], effort: ["low", "medium", "high"] },
};
const PLAIN_MODEL: DshCatalogModel = { provider: "openai", id: "gpt-4.1", contextWindow: 1_000_000, capabilities: { thinking: [], effort: [] } };

function bridge(overrides: Partial<DshModelBridge> = {}): DshModelBridge {
  return {
    providers: () => ["deepseek", "openai"],
    models: () => [THINKING_MODEL, PLAIN_MODEL],
    defaults: () => ({ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" }),
    sessionDefault: () => ({ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" }),
    ...overrides,
  };
}

/** 投影出 catalog 里的模型行（按 provider/model 定位）。 */
function rowOf(catalog: Record<string, unknown>, provider: string, model: string): Record<string, unknown> {
  const groups = catalog.groups as Array<{ id: string; models: Array<Record<string, unknown>> }>;
  const group = groups.find((item) => item.id === provider);
  expect(group, `缺少分组 ${provider}`).toBeDefined();
  const row = group?.models.find((item) => item.id === model);
  expect(row, `缺少模型 ${provider}/${model}`).toBeDefined();
  return row!;
}

describe("session/modelCatalog 投影", () => {
  it("按服务商分组、保留展示名，并给出部署默认与可路由服务商", () => {
    const catalog = projectModelCatalog(bridge());
    expect(catalog.default).toEqual({ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" });
    expect(catalog.routableProviders).toEqual(["deepseek", "openai"]);
    expect(catalog.failures).toEqual([]);
    expect((catalog.groups as unknown[]).length).toBe(2);
    expect(rowOf(catalog, "deepseek", "deepseek-reasoner").name).toBe("DeepSeek Reasoner");
    // 展示名缺省时回退 id
    expect(rowOf(catalog, "openai", "gpt-4.1").name).toBe("gpt-4.1");
  });

  it("reasoning 只在下发模型确实支持思考时出现，档位与默认档位来自 profile 与部署默认", () => {
    const catalog = projectModelCatalog(bridge());
    expect(rowOf(catalog, "deepseek", "deepseek-reasoner").reasoning).toEqual({
      efforts: [
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
      defaultEffort: "medium",
    });
    // 纯文本模型：不带 reasoning（不编造档位）
    expect(rowOf(catalog, "openai", "gpt-4.1").reasoning).toBeUndefined();
  });

  it("模型未声明 effort 档位时按「未声明=全开」下发全部合法档位", () => {
    const catalog = projectModelCatalog(bridge({
      models: () => [{ provider: "kimi", id: "k3", capabilities: { thinking: ["enabled"], effort: [] } }],
      defaults: () => undefined,
    }));
    const reasoning = rowOf(catalog, "kimi", "k3").reasoning as { efforts: Array<{ id: string }> };
    expect(reasoning.efforts.map((item) => item.id)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("未配置默认模型时回退到首个可路由模型的；目录为空则如实留空（不编造）", () => {
    const fallback = projectModelCatalog(bridge({ defaults: () => undefined }));
    expect(fallback.default).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    const empty = projectModelCatalog({ providers: () => [], models: () => [], defaults: () => undefined });
    expect(empty.default).toEqual({ provider: "", model: "" });
    expect(empty.groups).toEqual([]);
  });

  it("provider 未配置时保留在目录里，但不进 routableProviders（客户端据此展示不可用）", () => {
    const catalog = projectModelCatalog(bridge({ providers: () => ["openai"] }));
    expect(catalog.routableProviders).toEqual(["openai"]);
    expect((catalog.groups as unknown[]).length).toBe(2);
  });
});

describe("modelSelection 投影", () => {
  it("会话有选择时下发 next（effort → reasoningEffort）", () => {
    expect(modelSelectionValue({ provider: "deepseek", model: "deepseek-reasoner", effort: "high" }))
      .toEqual({ lastUsed: null, next: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } });
  });

  it("无 effort 时不带 reasoningEffort；provider/model 为空串（旧数据）时 next 为 null", () => {
    expect(modelSelectionValue({ provider: "openai", model: "gpt-4.1" })).toEqual({ lastUsed: null, next: { provider: "openai", model: "gpt-4.1" } });
    expect(modelSelectionValue({ provider: "", model: "" })).toEqual({ lastUsed: null, next: null });
  });
});

describe("session/selectModel", () => {
  function deps(overrides: Partial<Parameters<typeof projectSelectModel>[0]> = {}) {
    const apply = vi.fn(async () => undefined);
    const base = {
      providers: () => ["deepseek", "openai"],
      models: () => [THINKING_MODEL, PLAIN_MODEL],
      defaults: () => undefined,
      selectionOf: async () => ({ provider: "openai", model: "gpt-4.1" }),
      isRunning: () => false,
      apply,
      ...overrides,
    };
    return { deps: base, apply };
  }

  it("合法选择落盘并回显", async () => {
    const { deps: d, apply } = deps();
    const result = await projectSelectModel(d, { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } });
    expect(result).toEqual({ value: { selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } } });
    expect(apply).toHaveBeenCalledWith("s1", { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" });
  });

  it("会话不存在 / 运行中 / 服务商未配置 / 模型不在目录 / effort 超出声明 —— 各给明确 wire 错误", async () => {
    const cases: Array<{ overrides: Partial<Parameters<typeof projectSelectModel>[0]>; args: Record<string, unknown>; code: string }> = [
      { overrides: { selectionOf: async () => undefined }, args: { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner" } }, code: "session/not-found" },
      { overrides: { isRunning: () => true }, args: { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner" } }, code: "session/agent-busy" },
      { overrides: {}, args: { request: { sessionId: "s1", provider: "anthropic", model: "claude" } }, code: "session/model-unavailable" },
      { overrides: {}, args: { request: { sessionId: "s1", provider: "deepseek", model: "不存在" } }, code: "session/model-unavailable" },
      { overrides: {}, args: { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "ultra" } }, code: "session/arguments-invalid" },
      { overrides: {}, args: { request: { provider: "deepseek", model: "deepseek-reasoner" } }, code: "session/arguments-invalid" },
    ];
    for (const item of cases) {
      const { deps: d, apply } = deps(item.overrides);
      const result = await projectSelectModel(d, item.args);
      expect("error" in result && result.error.code, JSON.stringify(item.args)).toBe(item.code);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it("模型未声明档位时 effort 放行（与 REST 的「未声明=全开」一致）", async () => {
    const { deps: d, apply } = deps({ models: () => [PLAIN_MODEL] });
    const result = await projectSelectModel(d, { request: { sessionId: "s1", provider: "openai", model: "gpt-4.1", reasoningEffort: "ultra" } });
    expect("value" in result).toBe(true);
    expect(apply).toHaveBeenCalledWith("s1", { provider: "openai", model: "gpt-4.1", reasoningEffort: "ultra" });
  });
});

describe("createDshModelBridge（owc 事实 → 桥）", () => {
  function sources(overrides: { defaultModel?: { provider: string; model: string }; defaultEffort?: string; effortDeclared?: string[] } = {}): DshModelSources {
    const declared = (overrides.effortDeclared ?? ["low", "medium", "high"]) as never[];
    const profile = { id: "m1", provider: "deepseek", contextWindow: 1_000, capabilities: { modalities: [], imageOutput: false, thinking: [], effort: declared, tools: true } };
    return {
      providers: { list: () => ["deepseek"] },
      models: {
        list: () => [{ ...profile, source: "manual" } as never],
        get: () => profile as never,
      },
      settings: {
        effective: () => ({
          ...(overrides.defaultModel === undefined ? { defaultModel: { provider: "deepseek", model: "m1" } } : { defaultModel: overrides.defaultModel }),
          ...(overrides.defaultEffort === undefined ? {} : { defaultEffort: overrides.defaultEffort as never }),
        }),
      },
    };
  }

  it("默认选择来自 settings.defaultModel；defaultEffort 通过能力白名单后带上", () => {
    expect(defaultDshSelection(sources({ defaultEffort: "medium" }))).toEqual({ provider: "deepseek", model: "m1", reasoningEffort: "medium" });
    // 模型不支持该力度：静默不带 effort（与 REST 新建会话同口径）
    expect(defaultDshSelection(sources({ defaultEffort: "ultra" }))).toEqual({ provider: "deepseek", model: "m1" });
  });

  it("sessionDefault：默认模型的服务商不可路由时回落到首个可路由模型；全不可用时 undefined", () => {
    // settings.defaultModel 指向 deepseek，但只有 openai 配了凭据
    const sourcesWithFallback = sources();
    sourcesWithFallback.providers.list = () => ["openai"];
    expect(defaultDshSelection(sourcesWithFallback)).toEqual({ provider: "deepseek", model: "m1" });
    const bridgeFallback = createDshModelBridge(sourcesWithFallback);
    expect(bridgeFallback.sessionDefault()).toEqual({ provider: "deepseek", model: "m1" });
    // 目录里 deepseek 模型照常展示（客户端按 routable=false 展示不可用），但不会被用于建会话
  });

  it("未配置 defaultModel 时返回 undefined（不猜服务商）；catalog default 空串（如实）、建会话回退可路由模型", () => {
    const withoutDefault = { ...sources(), settings: { effective: () => ({}) } };
    const wired = createDshModelBridge(withoutDefault);
    expect(defaultDshSelection(withoutDefault)).toBeUndefined();
    expect(wired.defaults()).toBeUndefined();
    // catalog default：schema 要求 string → 无模型时如实空串
    expect(projectModelCatalog(wired).default).toEqual({ provider: "deepseek", model: "m1" });
    // 建会话回退到首个可路由模型（目录第一条），不落在空串上
    expect(wired.sessionDefault()).toEqual({ provider: "deepseek", model: "m1" });
  });

  it("无任何可路由服务商与模型时 sessionDefault 为 undefined（不写 provider/model）", () => {
    const bare: DshModelSources = {
      providers: { list: () => [] },
      models: { list: () => [], get: () => ({ capabilities: { effort: [] } } as never) },
      settings: { effective: () => ({}) },
    };
    const wired = createDshModelBridge(bare);
    expect(wired.sessionDefault()).toBeUndefined();
    expect(projectModelCatalog(wired).default).toEqual({ provider: "", model: "" });
  });
});

describe("pluginInventory/list 投影", () => {
  function plugin(overrides: Partial<DshPluginInfo>): DshPluginInfo {
    return {
      id: "@demo/plugin", name: "demo-plugin", version: "1.0.0", description: "", directory: "/data/dsh-plugins/demo",
      enabled: true, status: "running", dependencies: {}, ...overrides,
    } as DshPluginInfo;
  }

  it("状态映射为 fiber 相位；无活 fiber（停用）时为 null；不宣称可管理", () => {
    const snapshot = projectPluginInventory([
      plugin({}),
      plugin({ id: "@demo/slow", enabled: true, status: "missing-services" }),
      plugin({ id: "@demo/broken", enabled: true, status: "error" }),
      plugin({ id: "@demo/old", enabled: true, status: "incompatible" }),
      plugin({ id: "@demo/off", enabled: false, status: "disabled" }),
    ]);
    expect(snapshot.managementAvailable).toBe(false);
    expect(snapshot.entries).toEqual([
      { entryId: "@demo/plugin", moduleName: "demo-plugin", enabled: true, fiberPhase: "active" },
      { entryId: "@demo/slow", moduleName: "demo-plugin", enabled: true, fiberPhase: "pending" },
      { entryId: "@demo/broken", moduleName: "demo-plugin", enabled: true, fiberPhase: "failed" },
      { entryId: "@demo/old", moduleName: "demo-plugin", enabled: true, fiberPhase: "failed" },
      { entryId: "@demo/off", moduleName: "demo-plugin", enabled: false, fiberPhase: null },
    ]);
  });
});

describe("unary 端点注册（deps 缺模型面时不下发，客户端收到 method-unavailable 而不是假数据）", () => {
  function wireDeps(overrides: { models?: boolean; pluginInventory?: boolean } = {}) {
    return {
      projection: {} as DshProjectionDeps,
      events: {} as never,
      home: "/home",
      respondPermission: async () => undefined,
      respondInteraction: async () => undefined,
      logger: { warn: () => undefined },
      ...(overrides.models === true
        ? { models: { catalog: () => ({}), select: async () => ({ value: { selected: { provider: "p", model: "m" } } }) } }
        : {}),
      ...(overrides.pluginInventory === true ? { pluginInventory: () => [] } : {}),
    };
  }

  it("带 models / pluginInventory 时注册三个新端点；不带时一个都不注册", async () => {
    const { buildUnaryHandlers } = await import("../src/dsh/web-protocol/streams.js");
    const full = buildUnaryHandlers(wireDeps({ models: true, pluginInventory: true }));
    expect([...full.keys()]).toContain("session/modelCatalog");
    expect([...full.keys()]).toContain("session/selectModel");
    expect([...full.keys()]).toContain("pluginInventory/list");

    const bare = buildUnaryHandlers(wireDeps());
    expect([...bare.keys()]).not.toContain("session/modelCatalog");
    expect([...bare.keys()]).not.toContain("session/selectModel");
    expect([...bare.keys()]).not.toContain("pluginInventory/list");
    // 主路径端点不受影响
    expect([...bare.keys()]).toContain("session/list");
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("契约校验：vendor 生成 codec（strict schema）", () => {
  async function loadDescriptors(): Promise<Map<string, {
    result: { create(): { parse(value: unknown): unknown } };
    parameters?: Array<{ name: string; codec: { create(): { parse(value: unknown): unknown } } }>;
  }>> {
    const module = await import(SESSION_CONTROLLER) as { default?: { descriptors?: Array<{ namespace: string; method: string; result: { create(): { parse(value: unknown): unknown } }; parameters?: Array<{ name: string; codec: { create(): { parse(value: unknown): unknown } } }> }> } };
    const descriptors = module.default?.descriptors ?? [];
    return new Map(descriptors.map((item) => [`${item.namespace}/${item.method}`, item]));
  }

  it("session/modelCatalog 与 session/selectModel 的投影值通过 strict schema", async () => {
    const descriptors = await loadDescriptors();
    const catalog = projectModelCatalog(bridge());
    const catalogDescriptor = descriptors.get("session/modelCatalog");
    expect(catalogDescriptor, "vendor 缺少 session/modelCatalog").toBeDefined();
    expect(catalogDescriptor?.result.create().parse(catalog)).toBeDefined();

    const selectDescriptor = descriptors.get("session/selectModel");
    expect(selectDescriptor, "vendor 缺少 session/selectModel").toBeDefined();
    expect(selectDescriptor?.result.create().parse({ selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } })).toBeDefined();
    // 入参同样过客户端的 request schema（我方消费的 shape 必须与 wire 契约一致）
    const requestCodec = selectDescriptor?.parameters?.[0]?.codec;
    expect(requestCodec, "session/selectModel 应有单个 request 参数").toBeDefined();
    expect(requestCodec?.create().parse({ sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" })).toBeDefined();
  });

  it("含 modelSelection 的 control 基线通过 strict schema", async () => {
    const descriptors = await loadDescriptors();
    const meta = {
      id: "s1", cwd: "/work/proj", provider: "deepseek", model: "deepseek-reasoner", effort: "high",
      title: "会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as SessionMeta;
    const messages: ChatMessage[] = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:00:01.000Z" }];
    const projection = {
      sessions: {
        list: async () => [meta],
        create: async () => meta,
        get: async () => ({ ...meta, messages, hasMoreMessages: false } as SessionDetail),
        getMeta: async () => meta,
        getTail: async () => ({ ...meta, messages, hasMoreMessages: false }) as SessionDetail,
        updateConfig: async () => meta,
      },
      agent: {},
      defaultCwd: "/work",
    } as unknown as DshProjectionDeps;
    const baseline = await projectSessionControlBaseline(projection, "s1");
    const value = "value" in baseline ? baseline.value : undefined;
    expect(value).toBeDefined();
    const descriptor = descriptors.get("session/control");
    expect(descriptor, "vendor 缺少 session/control").toBeDefined();
    expect(descriptor?.result.create().parse(value)).toBeDefined();
  });
});
