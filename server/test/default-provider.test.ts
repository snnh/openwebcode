import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { lookupModelMetadata } from "../src/context/model-metadata.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SettingsService } from "../src/settings-service.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-default-provider-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const settings = await SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
  const agent = { isRunning: () => false } as AgentRunner;
  const core = {} as CoreClient;
  settings.bind({ providers, core, agent, events });
  const models = await ModelRegistry.load({
    snapshotPath: path.join(root, "models.json"),
    manualPath: path.join(root, "models.manual.json"),
  });
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, settings, models });
  return { root, sessions, providers, settings, models, app };
}

describe("default session provider", () => {
  it("uses the first enabled provider and its first catalog model", async () => {
    const setup = await fixture();
    try {
      const metadata = lookupModelMetadata("anthropic-default-test");
      await setup.models.upsertManual({
        id: "anthropic-default-test",
        provider: "anthropic",
        source: "manual",
        contextWindow: metadata.contextWindow,
        maxOutput: metadata.maxOutput,
        capabilities: metadata.capabilities,
      });
      setup.providers.register(makeStubProvider("anthropic"));

      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ provider: "anthropic", model: "anthropic-default-test" });
    } finally {
      await setup.app.close();
    }
  });

  it("keeps an unselected model exportable when the enabled provider has no catalog entry", async () => {
    const setup = await fixture();
    try {
      setup.providers.register(makeStubProvider("anthropic"));
      const created = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ provider: "anthropic", model: "" });

      const exported = await setup.sessions.exportJsonl(created.json<{ id: string }>().id);
      const imported = await setup.sessions.importJsonl(exported!);
      expect(imported).toMatchObject({ provider: "anthropic", model: "" });
    } finally {
      await setup.app.close();
    }
  });

  it("rejects an implicit session when no provider credentials are configured", async () => {
    const setup = await fixture();
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "NO_PROVIDER",
        message: "请先在设置中配置至少一个 API 密钥",
      });
    } finally {
      await setup.app.close();
    }
  });

  it("keeps an explicitly selected registered provider and model", async () => {
    const setup = await fixture();
    try {
      setup.providers.register(makeStubProvider("test-stub"));
      const response = await setup.app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { cwd: setup.root, provider: "test-stub", model: "explicit-model" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ provider: "test-stub", model: "explicit-model" });
    } finally {
      await setup.app.close();
    }
  });

});
