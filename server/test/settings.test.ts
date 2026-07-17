import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SettingsService, type SettingsFieldView, type SettingsView } from "../src/settings-service.js";

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
  return { root, providers, events: observed, app };
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
      expect(view.groups.map((group) => group.id)).toEqual(["models", "general", "executor", "service", "exchangeRate"]);
      const fields = view.groups.flatMap((group) => group.fields);
      expect(fields).toHaveLength(15);
      for (const item of fields) {
        expect(item.source).toBe("default");
        expect(item.editable).toBe(true);
      }
      expect(field(view, "port").value).toBe(3210);
      expect(field(view, "anthropicPromptCaching").value).toBe(true);
      expect(field(view, "anthropicApiKey").hasValue).toBe(false);
      expect(field(view, "host").restartRequired).toBe(true);
      expect(field(view, "defaultLanguage").restartRequired).toBe(false);
    } finally {
      await setup.app.close();
    }
  });

  it("masks env-provided secrets and never leaks the raw value", async () => {
    const setup = await fixture({ ANTHROPIC_API_KEY: "sk-ant-secret-key-1234567890" });
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("sk-ant-secret-key-1234567890");
      const view = response.json<SettingsView>();
      const secret = field(view, "anthropicApiKey");
      expect(secret.source).toBe("env");
      expect(secret.editable).toBe(false);
      expect(secret.hasValue).toBe(true);
      expect(secret.value).toBeNull();
      expect(secret.masked).toBe("sk-ant-…7890");
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
    const setup = await fixture({ OWC_PORT: "4000", ANTHROPIC_API_KEY: "sk-ant-secret-key-1234567890" });
    try {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { port: 4321, anthropicApiKey: "sk-ant-other-key-abcdefghij" } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("OWC_PORT");

      const view = (await setup.app.inject({ method: "GET", url: "/api/settings" })).json<SettingsView>();
      expect(field(view, "port")).toMatchObject({ value: 4000, source: "env", editable: false });
    } finally {
      await setup.app.close();
    }
  });

  it("hot-applies anthropic credentials so the provider appears and disappears live", async () => {
    const setup = await fixture();
    try {
      expect(setup.providers.list()).not.toContain("anthropic");

      const put = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { anthropicApiKey: "sk-ant-test-key-abcdefghij" } },
      });
      expect(put.statusCode).toBe(200);
      expect(setup.providers.list()).toContain("anthropic");
      const providersResponse = await setup.app.inject({ method: "GET", url: "/api/providers" });
      expect(providersResponse.json<string[]>()).toContain("anthropic");

      const cleared = await setup.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { overrides: { anthropicApiKey: null } },
      });
      expect(cleared.statusCode).toBe(200);
      expect(setup.providers.list()).not.toContain("anthropic");

      const updates = setup.events.filter((event) => event.type === "server.settings_updated");
      expect(updates).toHaveLength(2);
      expect(updates[0]?.payload).toEqual({ keys: ["anthropicApiKey"] });
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
});
