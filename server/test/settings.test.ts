import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import installDefaultsDocument from "../src/config/defaults.json" with { type: "json" };
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { defaultCorePath, loadConfig } from "../src/config.js";
import { CoreClient } from "../src/core-client.js";
import { ensureDirWithMode } from "../src/fs-utils.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { CODE_DEFAULTS, encodeFastModelSelection, SettingsService, type SettingsFieldView, type SettingsView } from "../src/settings-service.js";
import { getOfficialUserAgent, getUserAgent } from "../src/user-agent.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "../src/remote-sync-scheduler.js";
import type { UpdateChecker } from "../src/update-checker.js";
import { tempRoot } from "./helpers/temp-roots.js";

const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await tempRoot("owc-settings-");
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
    expect(view.groups.map((group) => group.id)).toEqual(["models", "modelSelection", "general", "defaults", "context", "executor", "service", "network", "proxy", "webSearch", "exchangeRate", "updateCheck"]);
    const fields = view.groups.flatMap((group) => group.fields);
    expect(fields).toHaveLength(53);
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
    expect(field(view, "subAgentConcurrency")).toMatchObject({ type: "number", value: 2, restartRequired: false });
    expect(field(view, "spawnSwarmConcurrency")).toMatchObject({ type: "number", value: 4, restartRequired: false });
    expect(field(view, "userAgent")).toMatchObject({ type: "text", value: null, nullable: true, restartRequired: false });
    expect(field(view, "allowedOrigins")).toMatchObject({ type: "text", value: null, nullable: true, restartRequired: true });
    expect(field(view, "providerStreamIdleMs")).toMatchObject({ type: "number", value: null, nullable: true, restartRequired: true });
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
      timeoutMs: 60_000,
    });
    expect(setup.fastModel).toMatchObject({ configured: true, provider: "主服务", model: "fast-1" });
  });

  it("override 持久化/清除语义（null 与写默认值等价）", async () => {
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

    // 覆盖经 PUT 写入文件并持久化，source=file；null 清回默认
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
    const finalPersisted = JSON.parse(await readFile(path.join(setup.root, "server-settings.json"), "utf8")) as {
      overrides: Record<string, unknown>;
    };
    expect("defaultLanguage" in finalPersisted.overrides).toBe(false);
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
      { compactionThresholdPercent: 49 },
      { compactionThresholdPercent: 101 },
      { compactionThresholdPercent: 85.5 },
      { exchangeRateUrl: "ftp://example.com" },
      { catalogSyncUrl: "ftp://example.com" },
      { syncIntervalMinutes: -1 },
      { syncIntervalMinutes: 1.5 },
      { syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES + 1 },
      { sandboxAllowPaths: "D:\\not-an-array" },
      { sandboxAllowPaths: Array.from({ length: 17 }, (_, index) => `D:\\path-${index}`) },
      { jobObjectMemoryMB: 1_048_577 },
      { jobObjectMaxProcesses: 4097 },
      { subAgentConcurrency: 0 },
      { subAgentConcurrency: 17 },
      { subAgentConcurrency: 1.5 },
      { spawnSwarmConcurrency: 1 },
      { spawnSwarmConcurrency: 17 },
      { userAgent: "带\n换行" },
      { userAgent: "x".repeat(201) },
      { userAgent: "   " },
      { allowedOrigins: "https://a.example.com/path" },
      { allowedOrigins: "ftp://a.example.com" },
      { providerStreamIdleMs: -1 },
      { providerStreamIdleMs: 86_400_001 },
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
    const root = await tempRoot("owc-jobobject-");
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

  it("exposes the new concurrency / userAgent / stream-idle settings from env (env 优先且不可 UI 覆盖)", async () => {
    const root = await tempRoot("owc-newenv-");
    const configured = await SettingsService.load({
      env: {
        OWC_SUB_AGENT_CONCURRENCY: "3",
        OWC_SPAWN_SWARM_CONCURRENCY: "6",
        OWC_USER_AGENT: "  MyAgent/1.0  ",
        OWC_PROVIDER_STREAM_IDLE_MS: "0",
        OWC_ALLOWED_ORIGINS: "https://a.example.com,https://b.example.com",
      },
      filePath: path.join(root, "server-settings.json"),
    });
    const effective = configured.effective();
    expect(effective.subAgentConcurrency).toBe(3);
    expect(effective.spawnSwarmConcurrency).toBe(6);
    // userAgent 允许 env 直写首尾空白：effective 归一 trim
    expect(effective.userAgent).toBe("MyAgent/1.0");
    expect(effective.providerStreamIdleMs).toBe(0);
    expect(effective.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    await expect(configured.update({ subAgentConcurrency: 5 })).rejects.toThrow("OWC_SUB_AGENT_CONCURRENCY");
    expect(configured.effective().subAgentConcurrency).toBe(3);
    const unset = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    expect(unset.effective().subAgentConcurrency).toBe(2);
    expect(unset.effective().spawnSwarmConcurrency).toBe(4);
    expect(unset.effective().userAgent).toBeUndefined();
    expect(unset.effective().providerStreamIdleMs).toBeUndefined();
  });

  it("saves allowedOrigins and recomputes listener security from it", async () => {
    const setup = await fixture();
    const put = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { allowedOrigins: "https://b.example.com" } },
    });
    expect(put.statusCode).toBe(200);
    expect(field(put.json<SettingsView>(), "allowedOrigins")).toMatchObject({ value: "https://b.example.com", source: "file" });
    expect(setup.settings.effective().allowedOrigins).toEqual(["https://b.example.com"]);
    expect(setup.settings.effective().autoAllowSameOrigin).toBeUndefined();
  });

  it("hot-applies the userAgent setting to the outbound User-Agent module", async () => {
    const setup = await fixture();
    // 未设置：官方默认（测试文件模块隔离，可直接断言真实 user-agent 模块）
    expect(getUserAgent()).toBe(getOfficialUserAgent());
    const put = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { userAgent: "CustomAgent/9.9" } },
    });
    expect(put.statusCode).toBe(200);
    expect(field(put.json<SettingsView>(), "userAgent")).toMatchObject({ value: "CustomAgent/9.9", source: "file" });
    expect(getUserAgent()).toBe("CustomAgent/9.9");
    const cleared = await setup.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { userAgent: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(getUserAgent()).toBe(getOfficialUserAgent());
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

  it("设置分组布局（general/defaults/context/webSearch/modelSelection/models）", async () => {
    const setup = await fixture();
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    const groups = new Map(view.groups.map((group) => [group.id, group]));
    expect(groups.get("general")?.label).toBe("通用");
    expect(groups.get("general")?.fields.map((item) => item.key)).toEqual(["defaultLanguage", "defaultCurrency", "chatModeEnabled", "userAgent"]);
    expect(groups.get("defaults")?.label).toBe("会话默认");
    expect(groups.get("defaults")?.fields.map((item) => item.key)).toEqual(["defaultEffort", "defaultSnapshotMode", "snapshotBackend"]);
    expect(groups.get("context")?.label).toBe("上下文与运行");
    expect(groups.get("context")?.fields.map((item) => item.key)).toEqual(["compactionThresholdPercent", "compactMaxTokens", "agentMaxTurns", "subAgentMaxTurns", "subAgentConcurrency", "spawnSwarmConcurrency"]);
    expect(groups.get("webSearch")?.label).toBe("联网");
    expect(groups.get("webSearch")?.fields.map((item) => item.key)).toEqual(["offlineMode", "webSearchMode"]);

    const keyLists = new Map(view.groups.map((group) => [group.id, group.fields.map((item) => item.key)]));
    expect(keyLists.get("modelSelection")).toEqual([
      "defaultModel",
      "roleModelPremium",
      "roleModelBalanced",
      "fastModel",
      "fastModelThinking",
      "fastModelEffort",
      "fastModelTimeoutMs",
      "roleModelCheap",
    ]);
    expect(keyLists.get("models")).toEqual(["catalogSyncUrl", "pricingSyncUrl", "syncIntervalMinutes", "providerStreamIdleMs"]);
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

  it("compactionThresholdPercent 默认 85，50/85/95/100 合法且热生效（100 = 关闭阈值型强制压缩）", async () => {
    const setup = await fixture();
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "compactionThresholdPercent")).toMatchObject({
      type: "number", value: 85, source: "default", restartRequired: false, editable: true,
    });
    expect(setup.settings.effective().compactionThresholdPercent).toBe(85);

    for (const value of [50, 85, 95, 100]) {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { compactionThresholdPercent: value } },
      });
      expect(response.statusCode).toBe(200);
      // 热生效：effective() 现读
      expect(setup.settings.effective().compactionThresholdPercent).toBe(value);
    }
    expect(field((await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>(), "compactionThresholdPercent"))
      .toMatchObject({ value: 100, source: "file" });
  });

  it.each([
    { name: "OWC_COMPACTION_THRESHOLD_PERCENT", outOfRange: "40", error: />= 50/, valid: "70", value: 70, fieldKey: "compactionThresholdPercent", rejectedWrite: 80 },
    { name: "OWC_COMPACT_MAX_TOKENS", outOfRange: "1023", error: />= 1024/, valid: "32768", value: 32768, fieldKey: "compactMaxTokens", rejectedWrite: 65536 },
  ])("env $name 越界 fail-fast，合法值锁定界面写入", async ({ name, outOfRange, error, valid, value, fieldKey, rejectedWrite }) => {
    // 越界 env 在 loadConfig 直接抛错（与 boundedInteger 约定一致），服务不启动
    await expect(fixture({ [name]: outOfRange })).rejects.toThrow(error);

    const locked = await fixture({ [name]: valid });
    const lockedView = (await locked.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(lockedView, fieldKey)).toMatchObject({ value, source: "env", editable: false });
    expect(locked.settings.effective()[fieldKey]).toBe(value);
    const rejected = await locked.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { overrides: { [fieldKey]: rejectedWrite } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("env→ServerConfig 映射：两个 boundedInteger + OWC_OFFLINE", () => {
    expect(loadConfig({}).compactionThresholdPercent).toBe(85);
    expect(loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "50" }).compactionThresholdPercent).toBe(50);
    expect(loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "70" }).compactionThresholdPercent).toBe(70);
    expect(loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "95" }).compactionThresholdPercent).toBe(95);
    expect(loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "100" }).compactionThresholdPercent).toBe(100);
    // 越界与非法值一律抛错（与 agentMaxTurns 等数值环境变量的 boundedInteger 约定一致）
    expect(() => loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "40" })).toThrow(/>= 50/);
    expect(() => loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "101" })).toThrow(/100/);
    expect(() => loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "85.5" })).toThrow(/positive integer/);
    expect(() => loadConfig({ OWC_COMPACTION_THRESHOLD_PERCENT: "abc" })).toThrow(/positive integer/);

    expect(loadConfig({}).compactMaxTokens).toBe(65536);
    expect(loadConfig({ OWC_COMPACT_MAX_TOKENS: "1024" }).compactMaxTokens).toBe(1024);
    expect(loadConfig({ OWC_COMPACT_MAX_TOKENS: "32768" }).compactMaxTokens).toBe(32768);
    expect(loadConfig({ OWC_COMPACT_MAX_TOKENS: "256000" }).compactMaxTokens).toBe(256000);
    expect(() => loadConfig({ OWC_COMPACT_MAX_TOKENS: "1023" })).toThrow(/>= 1024/);
    expect(() => loadConfig({ OWC_COMPACT_MAX_TOKENS: "256001" })).toThrow(/256000/);
    expect(() => loadConfig({ OWC_COMPACT_MAX_TOKENS: "65536.5" })).toThrow(/positive integer/);
    expect(() => loadConfig({ OWC_COMPACT_MAX_TOKENS: "abc" })).toThrow(/positive integer/);

    expect(loadConfig({}).offlineMode).toBe(false);
    expect(loadConfig({ OWC_OFFLINE: "1" }).offlineMode).toBe(true);
    expect(loadConfig({ OWC_OFFLINE: "true" }).offlineMode).toBe(true);
    expect(loadConfig({ OWC_OFFLINE: "0" }).offlineMode).toBe(false);
  });

  it("compactMaxTokens 默认 65536，1024–256000 合法且热生效，0/负数/超界/非整数拒绝", async () => {
    const setup = await fixture();
    const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
    expect(field(view, "compactMaxTokens")).toMatchObject({
      type: "number", value: 65536, source: "default", restartRequired: false, editable: true,
    });
    expect(setup.settings.effective().compactMaxTokens).toBe(65536);

    for (const value of [1024, 65536, 256000]) {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { compactMaxTokens: value } },
      });
      expect(response.statusCode).toBe(200);
      // 热生效：effective() 现读
      expect(setup.settings.effective().compactMaxTokens).toBe(value);
    }
    for (const bad of [0, -1, 1023, 256001, 65536.5]) {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { compactMaxTokens: bad } },
      });
      expect(response.statusCode).toBe(400);
    }
    // 拒绝后 effective() 保持最后一次合法值
    expect(setup.settings.effective().compactMaxTokens).toBe(256000);
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
  it("install default + 用户覆盖合并", async () => {
    const root = await tempRoot("owc-defaults-");
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });

    const view = settings.view();
    const port = defaultsField(view, "port");
    expect(port.source).toBe("default");
    expect(port.value).toBe(port.installDefault);
    expect(port.installDefault).toBe(3210);

    await settings.update({ port: 9999 });
    const overridden = settings.view();
    const overriddenPort = defaultsField(overridden, "port");
    expect(overriddenPort.source).toBe("file");
    expect(overriddenPort.value).toBe(9999);
    expect(overriddenPort.installDefault).toBe(3210);
  });
});

describe("defaultCorePath 平台感知", () => {
  it("Windows 为 MSVC 多配置布局，POSIX 为单配置布局", () => {
    expect(defaultCorePath("win32")).toBe("../build/Debug/owc-exec.exe");
    expect(defaultCorePath("linux")).toBe("../build/owc-exec");
    expect(defaultCorePath("darwin")).toBe("../build/owc-exec");
  });

  it("loadConfig 缺省按当前平台出默认值，OWC_CORE_PATH 优先", () => {
    expect(loadConfig({}).corePath).toBe(defaultCorePath());
    expect(loadConfig({ OWC_CORE_PATH: "/custom/owc-exec" }).corePath).toBe("/custom/owc-exec");
  });

  it("SettingsService corePath：默认→文件覆盖", async () => {
    const root = await tempRoot("owc-corepath-");
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    expect(settings.effective().corePath).toBe(defaultCorePath());
    const view = settings.view();
    const field = view.groups.flatMap((group) => group.fields).find((item) => item.key === "corePath");
    expect(field?.value).toBe(defaultCorePath());

    await settings.update({ corePath: "/opt/owc/owc-exec" });
    expect(settings.effective().corePath).toBe("/opt/owc/owc-exec");
  });
});

const makePermsRoot = (): Promise<string> => tempRoot("owc-perms-");

const modeOf = async (target: string): Promise<number> => (await stat(target)).mode & 0o777;

// 权限位断言仅 POSIX 有意义；Windows 上这些调用一律 no-op，由其余用例覆盖功能路径。
describe.skipIf(process.platform === "win32")("数据目录与敏感文件权限（POSIX）", () => {
  it("敏感目录与文件 0700/0600（四类目标）", async () => {
    // ensureDirWithMode 创建并收紧目录
    const root = await makePermsRoot();
    const dir = path.join(root, "nested", "data");
    await ensureDirWithMode(dir, 0o700);
    expect(await modeOf(dir)).toBe(0o700);

    // sessions 根目录 0700；会话目录 0700；meta.json/messages.jsonl 0600
    const sessionsRoot = path.join(root, "sessions");
    const store = new SessionStore(sessionsRoot);
    await store.initialize();
    expect(await modeOf(sessionsRoot)).toBe(0o700);
    const meta = await store.create({ cwd: root });
    expect(await modeOf(path.join(sessionsRoot, meta.id))).toBe(0o700);
    expect(await modeOf(path.join(sessionsRoot, meta.id, "meta.json"))).toBe(0o600);
    expect(await modeOf(path.join(sessionsRoot, meta.id, "messages.jsonl"))).toBe(0o600);

    // server-settings.json 0600，所在目录 0700
    const settingsDir = path.join(root, "settings-dir");
    const settings = await SettingsService.load({ env: {}, filePath: path.join(settingsDir, "server-settings.json") });
    await settings.update({ port: 4321 });
    expect(await modeOf(settingsDir)).toBe(0o700);
    expect(await modeOf(path.join(settingsDir, "server-settings.json"))).toBe(0o600);

    // provider-profiles.json 0600，所在目录 0700
    const profilesDir = path.join(root, "profiles-dir");
    const profiles = await ProviderProfilesService.load({ filePath: path.join(profilesDir, "provider-profiles.json") });
    await profiles.upsertWeb(undefined, { id: "tavily-main", provider: "tavily", apiKey: "tvly-test-key" });
    expect(await modeOf(profilesDir)).toBe(0o700);
    expect(await modeOf(path.join(profilesDir, "provider-profiles.json"))).toBe(0o600);
  });
});

describe("ensureDirWithMode Windows no-op", () => {
  it("win32 平台只建目录，不尝试 chmod", async () => {
    const root = await makePermsRoot();
    const dir = path.join(root, "data");
    await ensureDirWithMode(dir, 0o700, "win32");
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});
