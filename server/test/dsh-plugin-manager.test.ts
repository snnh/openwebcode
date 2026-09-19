/**
 * 插件管理面 / 设置面回归（M-later）：`pluginManager/*`、`pluginInventory/list`、
 * `llm/listProviders|listConfigurableProviders`、`settings/describe`、`credentials/describe`。
 *
 * 形状判定一律用 **vendor 自己的 strict codec**（`dsh-api-remotes` 生成的 typert 描述符），
 * 不自己写一套宽松校验——这正是此前「假 endpoint/自造 fixture」漏掉真问题的教训。
 * vendor 缺失时整组跳过（CI 无网络也能跑门禁）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DshPluginInfo } from "../src/dsh/loader.js";
import { projectPluginInventory } from "../src/dsh/web-protocol/plugin-inventory.js";
import { projectPluginBundles, projectPluginEntries } from "../src/dsh/web-protocol/plugin-manager.js";
import { OWC_SETTINGS_NS, deriveKeyRef, projectSettingsDescribe } from "../src/dsh/web-protocol/settings-face.js";
import { buildUnaryHandlers, type DshWireDeps } from "../src/dsh/web-protocol/streams.js";
import { EventBus } from "../src/events/event-bus.js";
import type { DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import { VENDOR_READY } from "./helpers/dsh-vendor-wire.js";
import { loadVendorEndpointDescriptors } from "./helpers/dsh-vendor-remotes.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REMOTES_DESCRIPTORS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins", "@deepseek-ai", "dsh-api-remotes", "client.js");
const VENDOR_SKIP = VENDOR_READY && existsSync(REMOTES_DESCRIPTORS)
  ? undefined
  : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

function plugin(overrides: Partial<DshPluginInfo> & { id: string }): DshPluginInfo {
  return {
    name: `pkg-${overrides.id}`,
    version: "1.0.0",
    description: "示例插件",
    directory: `/data/dsh-plugins/${overrides.id}`,
    entry: "index.js",
    enabled: true,
    status: "running",
    dependencies: {},
    ...overrides,
  };
}

/** 真实端点表 + 假插件状态（setEnabled 可注入以验证启停链路）。 */
function deps(options: { plugins?: DshPluginInfo[] } = {}) {
  const plugins = options.plugins ?? [
    plugin({ id: "alpha" }),
    plugin({ id: "beta", name: "pkg-beta", enabled: false, status: "disabled" }),
    plugin({ id: "gamma", name: "pkg-beta", status: "missing-services", missing: ["llm"] }),
  ];
  const projection = { sessions: {}, agent: { isRunning: () => false }, defaultCwd: "/work" } as unknown as DshProjectionDeps;
  const wire: DshWireDeps = {
    projection,
    events: new EventBus(),
    home: "/home/tester",
    pluginInventory: () => plugins,
    pluginManager: { plugins: () => plugins },
    settings: {
      profiles: () => [
        { id: "mock", enabled: true, interfaceType: "openai-chat-completions", baseURL: "http://127.0.0.1:19000/v1", hasApiKey: true },
        { id: "unused", enabled: false, interfaceType: "anthropic-messages", hasApiKey: false },
      ],
    },
    models: { catalog: () => ({}), select: async () => ({ value: { selected: { provider: "", model: "" } } }), providers: () => ["mock"] },
    respondPermission: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    logger: { warn: () => {} },
  };
  return { wire, plugins, handlers: buildUnaryHandlers(wire) };
}

describe("dsh 插件管理面（投影 + 启停）", () => {
  it("listBundles 按包名分组、rows 关联 entryId；listPlugins 带 fiberPhase 与只读标记", () => {
    const { plugins } = deps();
    const bundles = projectPluginBundles({ plugins: () => plugins }) as Array<Record<string, unknown>>;
    // pkg-alpha 与 pkg-beta 两个包；beta 包下两个条目（其中一个停用）
    expect(bundles.map((bundle) => bundle.name).sort()).toEqual(["pkg-alpha", "pkg-beta"]);
    const beta = bundles.find((bundle) => bundle.name === "pkg-beta")!;
    expect(beta.rows).toHaveLength(2);
    expect(beta.enabled).toBe(true);
    expect(beta.removable).toBe(false);
    // 面板只读：bundle 与每条 entry 都必须带 readOnlyReason（vendor codec 要求），UI 据此置灰
    expect(beta.readOnlyReason).toBe("management-required");
    expect((beta.rows as Array<Record<string, unknown>>).every((row) => row.rowId !== undefined)).toBe(true);
    const entries = projectPluginEntries({ plugins: () => plugins });
    expect(entries.map((entry) => [entry.entryId, entry.fiberPhase])).toEqual([
      ["alpha", "active"],
      ["beta", null],
      ["gamma", "pending"],
    ]);
    expect(projectPluginEntries({ plugins: () => plugins }, "pkg-beta").map((entry) => entry.entryId)).toEqual(["beta", "gamma"]);
    // 每条 entry 都带只读原因（不裸 entry：裸 entry 会被 vendor strict codec 直接拒收）
    expect(entries.every((entry) => entry.readOnlyReason === "management-required")).toBe(true);
  });

  it("pluginInventory/list 的 managementAvailable 决定插件页是否列条目（false 时整页显示「无可管理 profile」）", () => {
    const { plugins } = deps();
    expect(projectPluginInventory(plugins, false).managementAvailable).toBe(false);
    expect(projectPluginInventory(plugins, true).managementAvailable).toBe(true);
    expect((projectPluginInventory(plugins, true).entries as unknown[]).length).toBe(3);
  });

  it("启停动词一律如实失败（面板只读）：非法入参 → invalid-spec，未知插件 → unknown-plugin，可用插件 → management-required", async () => {
    const { handlers } = deps();
    const call = (args: Record<string, unknown>) => handlers.get("pluginManager/setPluginEnabled")!(args);
    await expect(call({ id: "beta", enabled: true })).resolves.toMatchObject({
      value: { changed: false, application: "failed", stage: "enable", target: "beta", error: { code: "management-required" } },
    });
    await expect(call({ id: "nope", enabled: true })).resolves.toMatchObject({ value: { application: "failed", error: { code: "unknown-plugin" } } });
    await expect(call({ enabled: true })).resolves.toMatchObject({ value: { application: "failed", error: { code: "invalid-spec" } } });
    await expect(call({ id: "alpha", enabled: "yes" })).resolves.toMatchObject({ value: { application: "failed", error: { code: "invalid-spec" } } });
  });

  it("bundle 启停/安装/卸载同样如实拒绝（不伪装成功）", async () => {
    const { handlers } = deps();
    await expect(handlers.get("pluginManager/setBundleEnabled")!({ name: "pkg-beta", enabled: true }))
      .resolves.toMatchObject({ value: { application: "failed", target: "pkg-beta", error: { code: "management-required" } } });
    await expect(handlers.get("pluginManager/setBundleEnabled")!({ name: "missing", enabled: true }))
      .resolves.toMatchObject({ value: { application: "failed", error: { code: "unknown-plugin" } } });
    await expect(handlers.get("pluginManager/removeBundle")!({ name: "pkg-beta" }))
      .resolves.toMatchObject({ value: { application: "failed", error: { code: "not-removable" } } });
    await expect(handlers.get("pluginManager/installBundle")!({ spec: "some-pkg" }))
      .resolves.toMatchObject({ value: { application: "failed", error: { code: "management-required" } } });
  });
});

describe("dsh 设置 / 模型目录面（只读投影）", () => {
  it("settings/describe 暴露 owc 服务商档案命名空间（只读 + secrets 只报是否已设置）", () => {
    const describe = projectSettingsDescribe({
      profiles: () => [
        { id: "mock", enabled: true, interfaceType: "openai-chat-completions", baseURL: "http://127.0.0.1:19000/v1", hasApiKey: true },
        { id: "unused", enabled: false, interfaceType: "anthropic-messages", hasApiKey: false },
      ],
    }) as { writable: boolean; namespaces: Array<{ ns: string; value: Record<string, unknown>; secrets: Array<{ path: string[]; set: boolean }> }> };
    expect(describe.writable).toBe(false);
    expect(describe.namespaces[0]?.ns).toBe(OWC_SETTINGS_NS);
    expect(describe.namespaces[0]?.value.mock).toMatchObject({ enabled: true, interfaceType: "openai-chat-completions" });
    expect(describe.namespaces[0]?.secrets).toEqual([
      { path: ["mock", "apiKey"], set: true },
      { path: ["unused", "apiKey"], set: false },
    ]);
    // 不泄漏任何密钥值
    expect(JSON.stringify(describe)).not.toContain("sk-");
  });

  it("凭据引用派生与 vendor deriveKeyRef 同规则（否则 UI 永远显示未配置）", () => {
    expect(deriveKeyRef("mock")).toBe("MOCK_API_KEY");
    expect(deriveKeyRef("my-vendor.ai")).toBe("MY_VENDOR_AI_API_KEY");
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("新端点形状（vendor strict codec）", () => {
  it("pluginInventory/list、pluginManager/listBundles|listPlugins、llm/*、settings/describe、credentials/describe 全部通过 vendor codec", async () => {
    const descriptors = await loadVendorEndpointDescriptors();
    const { handlers } = deps();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["pluginInventory/list", {}],
      ["pluginManager/listBundles", {}],
      ["pluginManager/listPlugins", {}],
      ["pluginManager/setPluginEnabled", { id: "beta", enabled: true }],
      ["pluginManager/setBundleEnabled", { name: "pkg-beta", enabled: false }],
      ["pluginManager/removeBundle", { name: "pkg-beta" }],
      ["pluginManager/installBundle", { spec: "x" }],
      ["llm/listProviders", {}],
      ["llm/listConfigurableProviders", {}],
      ["settings/describe", {}],
      ["credentials/describe", { refs: ["MOCK_API_KEY", "UNUSED_API_KEY"] }],
    ];
    for (const [endpoint, args] of cases) {
      const descriptor = descriptors.get(endpoint);
      expect(descriptor, `vendor 缺少 ${endpoint}`).toBeDefined();
      const handler = handlers.get(endpoint);
      expect(handler, `翻译层未注册 ${endpoint}`).toBeDefined();
      // 参数形状：只允许描述符声明的 wire 名（客户端不会发别的键）
      const wireNames = new Set(descriptor!.parameters.map((parameter) => parameter.wire));
      for (const key of Object.keys(args)) expect(wireNames.has(key), `${endpoint}: args 出现未声明参数 ${key}`).toBe(true);
      const projected = await handler!(args);
      expect("error" in projected, `${endpoint} 不应报错`).toBe(false);
      const value = (projected as { value: unknown }).value;
      try {
        descriptor!.result.create().parse(value);
      } catch (error) {
        throw new Error(`${endpoint} 未通过 vendor codec：${error instanceof Error ? error.message.slice(0, 400) : String(error)}\n${JSON.stringify(value).slice(0, 400)}`);
      }
    }
  });
});
