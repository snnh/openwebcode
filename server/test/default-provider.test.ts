import path from "node:path";
import { describe, expect, it } from "vitest";
import { lookupModelMetadata } from "../src/context/model-metadata.js";
import { ModelRegistry } from "../src/context/model-registry.js";
import { encodeFastModelSelection } from "../src/settings-service.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const setup = await makeTestApp({
    tempPrefix: "owc-default-provider-",
    settingsEnv: env,
    models: (root) => ModelRegistry.load({
      snapshotPath: path.join(root, "models.json"),
      manualPath: path.join(root, "models.manual.json"),
    }),
  });
  return { root: setup.root, sessions: setup.sessions, providers: setup.providers, settings: setup.settings!, models: setup.models!, app: setup.app };
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

describe("settings defaultModel for new sessions", () => {
  it("uses settings defaultModel for implicit session creation when still valid", async () => {
    const setup = await fixture({ OWC_DEFAULT_MODEL: encodeFastModelSelection("anthropic", "chosen-model") });
    try {
      const metadata = lookupModelMetadata("anthropic-default-test");
      // aaa-first 排序在前：若 defaultModel 未生效会回落到它，以此证明选择来自 settings
      for (const id of ["aaa-first", "chosen-model"]) {
        await setup.models.upsertManual({
          id,
          provider: "anthropic",
          source: "manual",
          contextWindow: metadata.contextWindow,
          maxOutput: metadata.maxOutput,
          capabilities: metadata.capabilities,
        });
      }
      setup.providers.register(makeStubProvider("anthropic"));
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ provider: "anthropic", model: "chosen-model" });
    } finally {
      await setup.app.close();
    }
  });

  it("falls back when defaultModel's provider is unregistered or the model left the catalog", async () => {
    const metadata = lookupModelMetadata("anthropic-default-test");
    for (const selection of [
      encodeFastModelSelection("ghost-provider", "chosen-model"),
      encodeFastModelSelection("anthropic", "ghost-model"),
    ]) {
      const setup = await fixture({ OWC_DEFAULT_MODEL: selection });
      try {
        await setup.models.upsertManual({
          id: "only-model",
          provider: "anthropic",
          source: "manual",
          contextWindow: metadata.contextWindow,
          maxOutput: metadata.maxOutput,
          capabilities: metadata.capabilities,
        });
        setup.providers.register(makeStubProvider("anthropic"));
        const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root } });
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ provider: "anthropic", model: "only-model" });
      } finally {
        await setup.app.close();
      }
    }
  });

  it("ignores defaultModel when provider or model is given explicitly", async () => {
    const setup = await fixture({ OWC_DEFAULT_MODEL: encodeFastModelSelection("anthropic", "chosen-model") });
    try {
      const metadata = lookupModelMetadata("anthropic-default-test");
      await setup.models.upsertManual({
        id: "chosen-model",
        provider: "anthropic",
        source: "manual",
        contextWindow: metadata.contextWindow,
        maxOutput: metadata.maxOutput,
        capabilities: metadata.capabilities,
      });
      setup.providers.register(makeStubProvider("anthropic"));
      const response = await setup.app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { cwd: setup.root, provider: "anthropic", model: "explicit-model" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ provider: "anthropic", model: "explicit-model" });
    } finally {
      await setup.app.close();
    }
  });

});
