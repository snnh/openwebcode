import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SettingsService, type SettingsFieldView, type SettingsView } from "../src/settings-service.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "../src/remote-sync-scheduler.js";

const roots: string[] = [];

afterEach(async () => {
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
  const settings = await SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
  settings.bind({ providers, core, agent, events });
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, settings });
  return { root, providers, events: observed, app, settings };
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
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      const view = response.json<SettingsView>();
      expect(view.groups.map((group) => group.id)).toEqual(["models", "provider2", "general", "executor", "service", "exchangeRate"]);
      const fields = view.groups.flatMap((group) => group.fields);
      expect(fields).toHaveLength(20);
      for (const item of fields) {
        expect(item.source).toBe("default");
        expect(item.editable).toBe(true);
      }
      expect(field(view, "port").value).toBe(3210);
      expect(field(view, "provider2ApiKey").hasValue).toBe(false);
      expect(field(view, "host").restartRequired).toBe(true);
      expect(field(view, "defaultLanguage").restartRequired).toBe(false);
      expect(field(view, "sandboxAllowPaths")).toMatchObject({ type: "pathList", value: [], restartRequired: true });
      expect(field(view, "catalogSyncUrl")).toMatchObject({ value: null, nullable: true, restartRequired: false });
      expect(field(view, "pricingSyncUrl")).toMatchObject({ value: null, nullable: true, restartRequired: false });
      expect(field(view, "syncIntervalMinutes")).toMatchObject({ type: "number", value: 0, restartRequired: false });
    } finally {
      await setup.app.close();
    }
  });

  it("masks env-provided fast-model secrets and never leaks the raw value", async () => {
    const setup = await fixture({ OWC_PROVIDER2_API_KEY: "fast-secret-key-1234567890" });
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("fast-secret-key-1234567890");
      const view = response.json<SettingsView>();
      const secret = field(view, "provider2ApiKey");
      expect(secret.source).toBe("env");
      expect(secret.editable).toBe(false);
      expect(secret.hasValue).toBe(true);
      expect(secret.value).toBeNull();
      expect(secret.masked).toBe("fast-se…7890");
    } finally {
      await setup.app.close();
    }
  });

  it("persists overrides, reports source=file, and clears back to default with null", async () => {
    const setup = await fixture();
    try {
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
    } finally {
      await setup.app.close();
    }
  });

  it("treats writing the default value as clearing the override", async () => {
    const setup = await fixture();
    try {
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
    } finally {
      await setup.app.close();
    }
  });

  it("rejects writes to env-controlled keys with 400", async () => {
    const setup = await fixture({ OWC_PORT: "4000" });
    try {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { port: 4321 } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("OWC_PORT");

      const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
      expect(field(view, "port")).toMatchObject({ value: 4000, source: "env", editable: false });
    } finally {
      await setup.app.close();
    }
  });

  it("returns 400 for invalid values and unknown keys", async () => {
    const setup = await fixture();
    try {
      for (const overrides of [
        { port: 0 },
        { port: 70_000 },
        { defaultCurrency: "EUR" },
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
    } finally {
      await setup.app.close();
    }
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
    try {
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
    } finally {
      await setup.app.close();
    }
  });

  it("persists remote sync settings and allows zero for manual-only sync", async () => {
    const setup = await fixture();
    try {
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
    } finally {
      await setup.app.close();
    }
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

});
