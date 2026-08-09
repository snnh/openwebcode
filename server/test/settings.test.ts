import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import installDefaultsDocument from "../src/config/defaults.json" with { type: "json" };
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CoreClient } from "../src/core-client.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { CODE_DEFAULTS, encodeFastModelSelection, SettingsService, type SettingsFieldView, type SettingsView } from "../src/settings-service.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "../src/remote-sync-scheduler.js";
import type { UpdateChecker } from "../src/update-checker.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-settings-"));
  roots.push(root);
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
  const profiles = await ProviderProfilesService.load({ filePath: path.join(root, "provider-profiles.json") });
  await profiles.upsertModel(undefined, {
    id: "主服务",
    enabled: true,
    interfaceType: "openai-chat-completions",
    baseURL: "https://example.test/v1",
  });
  const models = await ModelRegistry.load({
    snapshotPath: path.join(root, "models.json"),
    manualPath: path.join(root, "models.manual.json"),
  });
  await models.upsertManual({
    id: "fast-1",
    provider: "主服务",
    source: "manual",
    contextWindow: 128_000,
    capabilities: { modalities: ["text"], imageOutput: false, thinking: ["disabled"], effort: ["low", "high"], tools: true },
  });
  const fastModel = new FastModelClient(providers);
  const settings = await SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
  // fake updateChecker：记录热应用下发的 configure 入参（离线模式断言用），不发真实请求
  const updateCheckConfigs: Array<{ enabled: boolean }> = [];
  const updateChecker = {
    configure: (cfg: { enabled: boolean }) => { updateCheckConfigs.push(cfg); },
    refresh: () => Promise.resolve(undefined),
  };
  settings.bind({ providers, core, agent, events, fastModel, profiles, models, updateChecker: updateChecker as unknown as UpdateChecker });
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, settings });
  apps.push(app);
  return { root, providers, events: observed, app, settings, fastModel, updateCheckConfigs };
}

function field(view: SettingsView, key: string): SettingsFieldView {
  for (const group of view.groups) {
    const found = group.fields.find((item) => item.key === key);
    if (found) return found;
  }
  throw new Error(`Field ${key} not found in settings view`);
}

describe("server settings API", () => {
  it("returns every field with source=default by default", async () => {
    const setup = await fixture();
    const response = await setup.app.inject({ method: "GET", url: "/api/settings" });
    expect(response.statusCode).toBe(200);
    const view = response.json<SettingsView>();
    expect(view.groups.map((group) => group.id)).toEqual(["models", "modelSelection", "general", "executor", "service", "network", "proxy", "webSearch", "exchangeRate", "updateCheck"]);
    const fields = view.groups.flatMap((group) => group.fields);
    expect(fields).toHaveLength(41);
    for (const item of fields) {
      expect(item.source).toBe("default");
      expect(item.editable).toBe(true);
    }
    expect(field(view, "port").value).toBe(3210);
    expect(field(view, "nodeEnv")).toMatchObject({ type: "select", value: "global" });
    expect(field(view, "nodeEnv").options?.map((option) => option.value)).toEqual(["global", "project", "fnm", "nvm"]);
    expect(field(view, "webSearchMode")).toMatchObject({ type: "select", value: "local" });
    expect(field(view, "fastModel")).toMatchObject({
      type: "select",
      value: null,
      nullable: true,
      options: [{ value: encodeFastModelSelection("主服务", "fast-1"), label: "fast-1【主服务】" }],
    });
    expect(field(view, "host").restartRequired).toBe(true);
    expect(field(view, "defaultLanguage").restartRequired).toBe(false);
    expect(field(view, "sandboxAllowPaths")).toMatchObject({ type: "pathList", value: [], restartRequired: true });
    expect(field(view, "sandboxProxyDenyList")).toMatchObject({ type: "pathList", value: [], restartRequired: false });
    expect(field(view, "catalogSyncUrl")).toMatchObject({ value: null, nullable: true, restartRequired: false });
    expect(field(view, "pricingSyncUrl")).toMatchObject({ value: null, nullable: true, restartRequired: false });
    expect(field(view, "syncIntervalMinutes")).toMatchObject({ type: "number", value: 0, restartRequired: false });
  });

  it("selects a fast model from the unified catalog and hot-applies its request parameters", async () => {
    const setup = await fixture();
    const selection = encodeFastModelSelection("主服务", "fast-1");
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: {
        fastModel: selection,
        fastModelThinking: "enabled",
        fastModelEffort: "high",
      } },
    });
    expect(response.statusCode).toBe(200);
    const view = response.json<SettingsView>();
    expect(field(view, "fastModel")).toMatchObject({ value: selection, source: "file" });
    expect(field(view, "fastModelThinking")).toMatchObject({ value: "enabled", source: "file" });
    expect(field(view, "fastModelEffort")).toMatchObject({ value: "high", source: "file" });
    expect(setup.settings.effective().fastModel).toEqual({
      provider: "主服务",
      model: "fast-1",
      thinking: "enabled",
      effort: "high",
    });
    expect(setup.fastModel).toMatchObject({ configured: true, provider: "主服务", model: "fast-1" });
  });

  it("persists overrides, reports source=file, and clears back to default with null", async () => {
    const setup = await fixture();
    const put = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultLanguage: "en-US", port: 4321 } },
    });
    expect(put.statusCode).toBe(200);
    const view = put.json<SettingsView>();
    expect(field(view, "defaultLanguage")).toMatchObject({ value: "en-US", source: "file" });
    expect(field(view, "port")).toMatchObject({ value: 4321, source: "file" });

    const persisted = JSON.parse(await readFile(path.join(setup.root, "server-settings.json"), "utf8")) as {
      version: number;
      overrides: Record<string, unknown>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.overrides).toEqual({ defaultLanguage: "en-US", port: 4321 });

    const cleared = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultLanguage: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(field(cleared.json<SettingsView>(), "defaultLanguage")).toMatchObject({ value: "zh-CN", source: "default" });
  });

  it("treats writing the default value as clearing the override", async () => {
    const setup = await fixture();
    // 无覆盖时写默认值 = 无操作：不持久化、不广播
    const noop = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { port: 3210 } },
    });
    expect(noop.statusCode).toBe(200);
    expect(field(noop.json<SettingsView>(), "port").source).toBe("default");
    expect(setup.events.filter((event) => event.type === "server.settings_updated")).toHaveLength(0);
    await expect(readFile(path.join(setup.root, "server-settings.json"), "utf8")).rejects.toThrow();

    // 有覆盖时写回默认值 = 清除覆盖
    await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultLanguage: "en-US" } },
    });
    const back = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultLanguage: "zh-CN" } },
    });
    expect(field(back.json<SettingsView>(), "defaultLanguage").source).toBe("default");
    const persisted = JSON.parse(await readFile(path.join(setup.root, "server-settings.json"), "utf8")) as {
      overrides: Record<string, unknown>;
    };
    expect("defaultLanguage" in persisted.overrides).toBe(false);
  });

  it("rejects writes to env-controlled keys with 400", async () => {
    const setup = await fixture({ OWC_PORT: "4000" });
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { port: 4321 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("OWC_PORT");

    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "port")).toMatchObject({ value: 4000, source: "env", editable: false });
  });

  it("returns 400 for invalid values and unknown keys", async () => {
    const setup = await fixture();
    for (const overrides of [
      { port: 0 },
      { port: 70_000 },
      { defaultCurrency: "EUR" },
      { fastModel: "fast-1" },
      { fastModel: encodeFastModelSelection("未启用服务", "fast-1") },
      { defaultModel: "fast-1" },
      { defaultModel: encodeFastModelSelection("未启用服务", "fast-1") },
      { roleModelPremium: "fast-1" },
      { roleModelPremium: encodeFastModelSelection("未启用服务", "fast-1") },
      { roleModelBalanced: encodeFastModelSelection("主服务", "不存在的模型") },
      { roleModelCheap: encodeFastModelSelection("未启用服务", "fast-1") },
      { fastModelThinking: "sometimes" },
      { fastModelEffort: "extreme" },
      { coreRequestTimeoutMs: -5 },
      { exchangeRateUrl: "ftp://example.com" },
      { catalogSyncUrl: "ftp://example.com" },
      { syncIntervalMinutes: -1 },
      { syncIntervalMinutes: 1.5 },
      { syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES + 1 },
      { sandboxAllowPaths: "D:\\not-an-array" },
      { sandboxAllowPaths: Array.from({ length: 17 }, (_, index) => `D:\\path-${index}`) },
      { jobObjectMemoryMB: 1_048_577 },
      { jobObjectMaxProcesses: 4097 },
      { unknownKey: 1 },
    ]) {
      const response = await setup.app.inject({ method: "PUT", url: "/api/settings", payload: { overrides } });
      expect(response.statusCode).toBe(400);
    }
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "port").value).toBe(3210);
    expect(setup.events.filter((event) => event.type === "server.settings_updated")).toHaveLength(0);
  });

  it("exposes env-provided jobObject limits in the effective config and omits them by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-jobobject-"));
    roots.push(root);
    const configured = await SettingsService.load({
      env: { OWC_JOB_MEMORY_MB: "2048", OWC_JOB_MAX_PROCESSES: "32" },
      filePath: path.join(root, "server-settings.json"),
    });
    expect(configured.effective().sandbox?.jobObject).toEqual({ memoryMB: 2048, maxProcesses: 32 });
    const partial = await SettingsService.load({ env: { OWC_JOB_MAX_PROCESSES: "16" }, filePath: path.join(root, "server-settings.json") });
    expect(partial.effective().sandbox?.jobObject).toEqual({ maxProcesses: 16 });
    const unset = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    expect(unset.effective().sandbox).toBeUndefined();
  });

  it("persists AppContainer allow paths as an array and exposes them in effective config", async () => {
    const setup = await fixture();
    const allowPaths = ["D:\\cache", "D:\\shared"];
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { sandboxAllowPaths: allowPaths } },
    });
    expect(response.statusCode).toBe(200);
    expect(field(response.json<SettingsView>(), "sandboxAllowPaths")).toMatchObject({ value: allowPaths, source: "file" });
    expect(setup.settings.effective().sandbox?.allowPaths).toEqual(allowPaths);

    const cleared = await setup.app.inject({ method: "PUT", url: "/api/settings", payload: { overrides: { sandboxAllowPaths: [] } } });
    expect(field(cleared.json<SettingsView>(), "sandboxAllowPaths")).toMatchObject({ value: [], source: "default" });
    expect(setup.settings.effective().sandbox).toBeUndefined();
  });

  it("persists remote sync settings and allows zero for manual-only sync", async () => {
    const setup = await fixture();
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        overrides: {
          catalogSyncUrl: "https://example.com/models.json",
          pricingSyncUrl: "https://example.com/pricing.json",
          syncIntervalMinutes: 0,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const view = response.json<SettingsView>();
    expect(field(view, "catalogSyncUrl")).toMatchObject({ value: "https://example.com/models.json", source: "file" });
    expect(field(view, "pricingSyncUrl")).toMatchObject({ value: "https://example.com/pricing.json", source: "file" });
    // Writing the default zero should clear any override while preserving manual-only behavior.
    expect(field(view, "syncIntervalMinutes")).toMatchObject({ value: 0, source: "default" });
    expect(setup.settings.effective().models).toEqual({
      catalogSyncUrl: "https://example.com/models.json",
      pricingSyncUrl: "https://example.com/pricing.json",
      syncIntervalMinutes: 0,
    });

    const periodic = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { syncIntervalMinutes: 15 } },
    });
    expect(periodic.statusCode).toBe(200);
    expect(field(periodic.json<SettingsView>(), "syncIntervalMinutes")).toMatchObject({ value: 15, source: "file" });
    expect(setup.settings.effective().models.syncIntervalMinutes).toBe(15);

    const maximum = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES } },
    });
    expect(maximum.statusCode).toBe(200);
    expect(field(maximum.json<SettingsView>(), "syncIntervalMinutes")).toMatchObject({ value: MAX_SYNC_INTERVAL_MINUTES, source: "file" });
  });

  it("loads remote sync environment settings into ServerConfig", () => {
    expect(loadConfig({
      OWC_MODELS_CATALOG_SYNC_URL: "https://example.com/models.json",
      OWC_MODELS_PRICING_SYNC_URL: "https://example.com/pricing.json",
      OWC_MODELS_SYNC_INTERVAL_MINUTES: "15",
    }).models).toEqual({
      catalogSyncUrl: "https://example.com/models.json",
      pricingSyncUrl: "https://example.com/pricing.json",
      syncIntervalMinutes: 15,
    });
    expect(loadConfig({ OWC_MODELS_SYNC_INTERVAL_MINUTES: String(MAX_SYNC_INTERVAL_MINUTES) }).models.syncIntervalMinutes).toBe(MAX_SYNC_INTERVAL_MINUTES);
    expect(loadConfig({}).models).toEqual({ syncIntervalMinutes: 0 });
    expect(() => loadConfig({ OWC_MODELS_CATALOG_SYNC_URL: "ftp://example.com/models.json" })).toThrow(/http/i);
    expect(() => loadConfig({ OWC_MODELS_SYNC_INTERVAL_MINUTES: "-1" })).toThrow(/non-negative/i);
    expect(() => loadConfig({ OWC_MODELS_SYNC_INTERVAL_MINUTES: String(MAX_SYNC_INTERVAL_MINUTES + 1) })).toThrow(String(MAX_SYNC_INTERVAL_MINUTES));
  });

  it("offlineMode 默认关闭，可经界面覆盖并热生效，env OWC_OFFLINE 锁定", async () => {
    const setup = await fixture();
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "offlineMode")).toMatchObject({ type: "boolean", value: false, source: "default", restartRequired: false });
    expect(setup.settings.effective().offlineMode).toBe(false);

    const enabled = await setup.app.inject({ method: "PUT", url: "/api/settings", payload: { overrides: { offlineMode: true } } });
    expect(enabled.statusCode).toBe(200);
    expect(field(enabled.json<SettingsView>(), "offlineMode")).toMatchObject({ value: true, source: "file" });
    expect(setup.settings.effective().offlineMode).toBe(true);

    const envLocked = await fixture({ OWC_OFFLINE: "1" });
    const envView = (await envLocked.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(envView, "offlineMode")).toMatchObject({ value: true, source: "env", editable: false });
    expect(envLocked.settings.effective().offlineMode).toBe(true);
    const rejected = await envLocked.app.inject({ method: "PUT", url: "/api/settings", payload: { overrides: { offlineMode: false } } });
    expect(rejected.statusCode).toBe(400);
  });

  it("loads OWC_OFFLINE into ServerConfig", () => {
    expect(loadConfig({}).offlineMode).toBe(false);
    expect(loadConfig({ OWC_OFFLINE: "1" }).offlineMode).toBe(true);
    expect(loadConfig({ OWC_OFFLINE: "true" }).offlineMode).toBe(true);
    expect(loadConfig({ OWC_OFFLINE: "0" }).offlineMode).toBe(false);
  });

  it("离线模式下更新检查整体关闭（热生效把关）", async () => {
    const setup = await fixture();
    const put = (overrides: Record<string, unknown>) =>
      setup.app.inject({ method: "PUT", url: "/api/settings", payload: { overrides } });

    // 先开更新检查：configure 收到 enabled=true
    expect((await put({ updateCheckEnabled: true })).statusCode).toBe(200);
    expect(setup.updateCheckConfigs.at(-1)).toMatchObject({ enabled: true });

    // 开离线模式：configure 被重新下发且 enabled 压成 false
    expect((await put({ offlineMode: true })).statusCode).toBe(200);
    expect(setup.updateCheckConfigs.at(-1)).toMatchObject({ enabled: false });

    // 离线期间拨动更新检查开关也不会启用
    expect((await put({ updateCheckEnabled: false })).statusCode).toBe(200);
    expect(setup.updateCheckConfigs.at(-1)).toMatchObject({ enabled: false });
    expect((await put({ updateCheckEnabled: true })).statusCode).toBe(200);
    expect(setup.updateCheckConfigs.at(-1)).toMatchObject({ enabled: false });

    // 关离线模式：按 updateCheckEnabled 恢复
    expect((await put({ offlineMode: false })).statusCode).toBe(200);
    expect(setup.updateCheckConfigs.at(-1)).toMatchObject({ enabled: true });
  });

});

describe("model selection settings (modelSelection group)", () => {
  it("groups model-selection keys in order and keeps catalog sync keys under models", async () => {
    const setup = await fixture();
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    const groups = new Map(view.groups.map((group) => [group.id, group.fields.map((item) => item.key)]));
    expect(groups.get("modelSelection")).toEqual([
      "defaultModel",
      "roleModelPremium",
      "roleModelBalanced",
      "fastModel",
      "fastModelThinking",
      "fastModelEffort",
      "roleModelCheap",
    ]);
    expect(groups.get("models")).toEqual(["catalogSyncUrl", "pricingSyncUrl", "syncIntervalMinutes"]);
    for (const key of ["defaultModel", "roleModelPremium", "roleModelBalanced", "roleModelCheap"]) {
      expect(field(view, key)).toMatchObject({
        type: "select",
        value: null,
        nullable: true,
        restartRequired: false,
        options: [{ value: encodeFastModelSelection("主服务", "fast-1"), label: "fast-1【主服务】" }],
      });
    }
  });

  it("accepts encoded role/default selections, hot-applies them, and clears with null", async () => {
    const setup = await fixture();
    const selection = encodeFastModelSelection("主服务", "fast-1");
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: {
        defaultModel: selection,
        roleModelPremium: selection,
        roleModelBalanced: selection,
        roleModelCheap: selection,
      } },
    });
    expect(response.statusCode).toBe(200);
    const view = response.json<SettingsView>();
    for (const key of ["defaultModel", "roleModelPremium", "roleModelBalanced", "roleModelCheap"]) {
      expect(field(view, key)).toMatchObject({ value: selection, source: "file" });
    }
    // 热生效：effective() 现读，无需重启
    expect(setup.settings.effective().defaultModel).toEqual({ provider: "主服务", model: "fast-1" });
    expect(setup.settings.effective().roleModels).toEqual({
      premium: { provider: "主服务", model: "fast-1" },
      balanced: { provider: "主服务", model: "fast-1" },
      cheap: { provider: "主服务", model: "fast-1" },
    });
    expect(setup.events.some((event) =>
      event.type === "server.settings_updated" &&
      (event.payload as { keys?: string[] }).keys?.includes("defaultModel"))).toBe(true);

    const cleared = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultModel: null, roleModelPremium: null, roleModelBalanced: null, roleModelCheap: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(setup.settings.effective().defaultModel).toBeUndefined();
    expect(setup.settings.effective().roleModels).toBeUndefined();
  });

  it("honors env overrides for the new selection keys and locks them from UI writes", async () => {
    const selection = encodeFastModelSelection("主服务", "fast-1");
    const setup = await fixture({ OWC_DEFAULT_MODEL: selection, OWC_ROLE_MODEL_CHEAP: selection });
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "defaultModel")).toMatchObject({ value: selection, source: "env", editable: false });
    expect(field(view, "roleModelCheap")).toMatchObject({ value: selection, source: "env", editable: false });
    expect(setup.settings.effective().defaultModel).toEqual({ provider: "主服务", model: "fast-1" });
    expect(setup.settings.effective().roleModels?.cheap).toEqual({ provider: "主服务", model: "fast-1" });
    const response = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { defaultModel: selection } },
    });
    expect(response.statusCode).toBe(400);
  });

});

// ---- defaults-sync 组（合并） ----
const defaultsRoots: string[] = [];
afterEach(async () => Promise.all(defaultsRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function defaultsField(view: SettingsView, key: string): SettingsFieldView {
  for (const group of view.groups) {
    const found = group.fields.find((item) => item.key === key);
    if (found) return found;
  }
  throw new Error(`Field ${key} not found`);
}

describe("install-dir defaults sync guard", () => {
  it("config/defaults.json covers exactly the FIELDS keys with matching values", () => {
    const fileDefaults = installDefaultsDocument as Record<string, unknown>;
    const fileKeys = Object.keys(fileDefaults).sort();
    const codeKeys = [...CODE_DEFAULTS.keys()].sort();
    expect(fileKeys).toEqual(codeKeys);
    for (const key of codeKeys) {
      expect(fileDefaults[key], `default mismatch for ${key}`).toEqual(CODE_DEFAULTS.get(key));
    }
  });
});

describe("settings auto-combine (install default + user override)", () => {
  it("serves install defaults when nothing is overridden", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-defaults-"));
    defaultsRoots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    const view = settings.view();
    const port = defaultsField(view, "port");
    expect(port.source).toBe("default");
    expect(port.value).toBe(port.installDefault);
    expect(port.installDefault).toBe(3210);
  });

  it("keeps the user override and exposes the differing install default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-defaults-"));
    defaultsRoots.push(root);
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    await settings.update({ port: 9999 });
    const view = settings.view();
    const port = defaultsField(view, "port");
    expect(port.source).toBe("file");
    expect(port.value).toBe(9999);
    expect(port.installDefault).toBe(3210);
  });
});
