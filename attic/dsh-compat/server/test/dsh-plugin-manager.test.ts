/** 插件管理面 / 设置面回归（M-later）：`pluginManager/*`、`pluginInventory/list`、`llm/*`、
 * `settings/describe`、`credentials/describe`；形状判定一律用 vendor 自己的 strict codec。 */
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
const VENDOR_SKIP = VENDOR_READY && existsSync(REMOTES_DESCRIPTORS) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";
const PROFILES = [
  { id: "mock", enabled: true, interfaceType: "openai-chat-completions", baseURL: "http://127.0.0.1:19000/v1", hasApiKey: true },
  { id: "unused", enabled: false, interfaceType: "anthropic-messages", hasApiKey: false },
];
const plugin = (overrides: Partial<DshPluginInfo> & { id: string }): DshPluginInfo => ({
  name: `pkg-${overrides.id}`, version: "1.0.0", description: "示例插件", directory: `/data/dsh-plugins/${overrides.id}`,
  entry: "index.js", enabled: true, status: "running", dependencies: {}, ...overrides,
});
/** 真实端点表 + 假插件状态。 */
function deps() {
  // pkg-alpha 一个条目；pkg-beta 两个条目（其中一个停用、一个缺服务）
  const plugins = [plugin({ id: "alpha" }), plugin({ id: "beta", enabled: false, status: "disabled" }), plugin({ id: "gamma", name: "pkg-beta", status: "missing-services", missing: ["llm"] })];
  const wire: DshWireDeps = {
    projection: { sessions: {}, agent: { isRunning: () => false }, defaultCwd: "/work" } as unknown as DshProjectionDeps,
    events: new EventBus(),
    home: "/home/tester",
    pluginInventory: () => plugins,
    pluginManager: { plugins: () => plugins },
    settings: { profiles: () => PROFILES },
    models: { catalog: () => ({}), select: async () => ({ value: { selected: { provider: "", model: "" } } }), providers: () => ["mock"] },
    respondPermission: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    logger: { warn: () => {} },
  };
  return { wire, plugins, handlers: buildUnaryHandlers(wire) };
}
describe("dsh 插件管理面（投影只读 + 启停如实失败）", () => {
  it("listBundles 按包名分组、rows 关联 entryId；listPlugins 带 fiberPhase；只读原因齐备", () => {
    const { plugins } = deps();
    const bundles = projectPluginBundles({ plugins: () => plugins }) as Array<Record<string, unknown>>;
    expect(bundles.map((bundle) => bundle.name).sort()).toEqual(["pkg-alpha", "pkg-beta"]); // beta 包下两个条目
    const beta = bundles.find((bundle) => bundle.name === "pkg-beta");
    expect(beta).toMatchObject({ enabled: true, removable: false, readOnlyReason: "management-required" });
    expect(beta?.rows).toHaveLength(2);
    expect((beta?.rows as Array<Record<string, unknown>>).every((row) => row.rowId !== undefined)).toBe(true);
    const entries = projectPluginEntries({ plugins: () => plugins });
    // 面板只读：每条 entry 都必须带 readOnlyReason（裸 entry 会被 vendor strict codec 拒收）
    expect(entries.map((entry) => [entry.entryId, entry.fiberPhase, entry.readOnlyReason])).toEqual([
      ["alpha", "active", "management-required"],
      ["beta", null, "management-required"],
      ["gamma", "pending", "management-required"],
    ]);
    expect(projectPluginEntries({ plugins: () => plugins }, "pkg-beta").map((entry) => entry.entryId)).toEqual(["beta", "gamma"]);
    // managementAvailable 决定插件页是否列条目（false 时整页显示「无可管理 profile」）
    expect([projectPluginInventory(plugins, false).managementAvailable, projectPluginInventory(plugins, true).managementAvailable]).toEqual([false, true]);
    expect((projectPluginInventory(plugins, true).entries as unknown[]).length).toBe(3);
  });
  it("启停/安装/卸载动词一律如实失败：非法入参→invalid-spec、未知→unknown-plugin、可管理面→management-required/not-removable", async () => {
    const { handlers } = deps();
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["pluginManager/setPluginEnabled", { id: "beta", enabled: true }, { changed: false, application: "failed", stage: "enable", target: "beta", error: { code: "management-required" } }],
      ["pluginManager/setPluginEnabled", { id: "nope", enabled: true }, { application: "failed", error: { code: "unknown-plugin" } }],
      ["pluginManager/setPluginEnabled", { enabled: true }, { application: "failed", error: { code: "invalid-spec" } }],
      ["pluginManager/setPluginEnabled", { id: "alpha", enabled: "yes" }, { application: "failed", error: { code: "invalid-spec" } }],
      ["pluginManager/setBundleEnabled", { name: "pkg-beta", enabled: true }, { application: "failed", target: "pkg-beta", error: { code: "management-required" } }],
      ["pluginManager/setBundleEnabled", { name: "missing", enabled: true }, { application: "failed", error: { code: "unknown-plugin" } }],
      ["pluginManager/removeBundle", { name: "pkg-beta" }, { application: "failed", error: { code: "not-removable" } }],
      ["pluginManager/installBundle", { spec: "some-pkg" }, { application: "failed", error: { code: "management-required" } }],
    ];
    for (const [endpoint, args, expected] of cases) {
      await expect(handlers.get(endpoint)!(args), `${endpoint} ${JSON.stringify(args)}`).resolves.toMatchObject({ value: expected });
    }
  });
  it("settings/describe 暴露服务商档案命名空间（只读、secrets 只报是否已设置），凭据引用同 vendor 规则", () => {
    const describe = projectSettingsDescribe({ profiles: () => PROFILES }) as { writable: boolean; namespaces: Array<{ ns: string; value: Record<string, unknown>; secrets: Array<{ path: string[]; set: boolean }> }> };
    expect(describe.writable).toBe(false);
    expect(describe.namespaces[0]?.ns).toBe(OWC_SETTINGS_NS);
    expect(describe.namespaces[0]?.value.mock).toMatchObject({ enabled: true, interfaceType: "openai-chat-completions" });
    expect(describe.namespaces[0]?.secrets).toEqual([{ path: ["mock", "apiKey"], set: true }, { path: ["unused", "apiKey"], set: false }]);
    expect(JSON.stringify(describe)).not.toContain("sk-"); // 不泄漏任何密钥值
    // deriveKeyRef 必须与 vendor 同规则，否则 UI 永远显示未配置
    expect([deriveKeyRef("mock"), deriveKeyRef("my-vendor.ai")]).toEqual(["MOCK_API_KEY", "MY_VENDOR_AI_API_KEY"]);
  });
});
describe.skipIf(VENDOR_SKIP !== undefined)("新端点形状（vendor strict codec）", () => {
  it("pluginInventory/pluginManager/llm/settings/credentials 全部通过 vendor codec", async () => {
    const descriptors = await loadVendorEndpointDescriptors();
    const { handlers } = deps();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["pluginInventory/list", {}], ["pluginManager/listBundles", {}], ["pluginManager/listPlugins", {}],
      ["pluginManager/setPluginEnabled", { id: "beta", enabled: true }], ["pluginManager/setBundleEnabled", { name: "pkg-beta", enabled: false }],
      ["pluginManager/removeBundle", { name: "pkg-beta" }], ["pluginManager/installBundle", { spec: "x" }],
      ["llm/listProviders", {}], ["llm/listConfigurableProviders", {}], ["settings/describe", {}],
      ["credentials/describe", { refs: ["MOCK_API_KEY", "UNUSED_API_KEY"] }],
    ];
    for (const [endpoint, args] of cases) {
      const descriptor = descriptors.get(endpoint);
      expect(descriptor, `vendor 缺少 ${endpoint}`).toBeDefined();
      const handler = handlers.get(endpoint);
      expect(handler, `翻译层未注册 ${endpoint}`).toBeDefined();
      // 参数形状：只允许描述符声明的 wire 名（客户端不会发别的键）
      const wireNames = new Set(descriptor!.parameters.map((parameter) => parameter.wire));
      expect(Object.keys(args).filter((key) => !wireNames.has(key)), `${endpoint}: args 出现未声明参数`).toEqual([]);
      const projected = await handler!(args);
      expect("error" in projected, `${endpoint} 不应报错`).toBe(false);
      expect(() => descriptor!.result.create().parse((projected as { value: unknown }).value), `${endpoint} 未通过 vendor codec`).not.toThrow();
    }
  });
});
