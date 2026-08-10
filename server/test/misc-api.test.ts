import path from "node:path";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient, CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UpdateChecker } from "../src/update-checker.js";
import { setServerVersion } from "../src/version.js";
import { FAKE_CORE_INFO } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("WebUI static hosting", () => {
  it("serves the production index without shadowing API routes", async () => {
    const root = await tempRoot("owc-web-static-");
    const webDist = path.join(root, "web");
    await mkdir(webDist);
    await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>OpenWebCode</title>", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events,
      providers: new ProviderRegistry(),
      pricing,
      webDist,
    });
    try {
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("OpenWebCode");
      expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(page.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json()).toEqual({ status: "ok" });
      // API 响应不叠加 CSP（无渲染面）
      expect(health.headers["content-security-policy"]).toBeUndefined();
      expect((await app.inject({ method: "GET", url: "/api/metrics" })).json()).toMatchObject({ events: events.stats(), websocket: { clients: 0, slowClientDisconnects: 0, failedClientSends: 0 } });
    } finally {
      await app.close();
    }
  });
});

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

afterEach(() => setServerVersion("0.0.0"));

function stubCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return {}; },
    async ping() { return { version: "test" }; },
  } as unknown as CoreClientLike;
  return core;
}

async function setupPerfApi() {
  const root = await tempRoot("owc-perf-api-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = stubCore();
  const events = new EventBus();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  apps.push(app);
  return { app, session, agent, events };
}

describe("性能采样 REST 契约（0.5.0 Phase 2d）", () => {
  it("GET /api/sessions/:id/perf 无记录时返回空数组", async () => {
    const { app, session } = await setupPerfApi();
    const response = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/perf` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ records: [] });
  });

  it("GET /api/sessions/:id/perf 不存在的会话返回 404", async () => {
    const { app } = await setupPerfApi();
    const response = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/perf" });
    expect(response.statusCode).toBe(404);
  });
});

function fakeCore(): CoreClientLike {
  const emitter = new EventEmitter();
  const client = {
    on(eventName: string, listener: (...args: unknown[]) => void) { emitter.on(eventName, listener); return client; },
    async start() { return FAKE_CORE_INFO; },
    async stop() { return; },
    async ping() { return FAKE_CORE_INFO; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;
  return client;
}

async function setupVersionApi(updateChecker?: UpdateChecker) {
  const root = await tempRoot("owc-version-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "model-pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const core = fakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(updateChecker ? { updateChecker } : {}) });
  return { app, root };
}

describe("/api/version", () => {
  it("returns server, core, protocol and repo info", async () => {
    setServerVersion("0.5.2");
    const { app } = await setupVersionApi();
    try {
      const response = await app.inject({ method: "GET", url: "/api/version" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ server: string; core: string; protocolVersion: string; githubRepo: string }>();
      expect(body.server).toBe("0.5.2");
      expect(body.core).toBe(FAKE_CORE_INFO.version);
      expect(body.protocolVersion).toBe("1.0");
      expect(body.githubRepo).toBe("snnh/openwebcode");
    } finally {
      await app.close();
    }
  });
});

describe("/api/update-check", () => {
  it("returns 501 when no update checker is configured", async () => {
    const { app } = await setupVersionApi();
    try {
      const response = await app.inject({ method: "GET", url: "/api/update-check" });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("returns the checker snapshot and refreshes on demand", async () => {
    setServerVersion("0.5.2");
    const root = await tempRoot("owc-version-uc-");
    const checker = new UpdateChecker({
      cachePath: path.join(root, "update-check.json"),
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: "v0.6.0", html_url: "https://github.com/snnh/openwebcode/releases/tag/v0.6.0", published_at: "2026-07-27T00:00:00Z" }), { status: 200 }),
    });
    checker.configure({ enabled: true, intervalHours: 24 });
    const { app } = await setupVersionApi(checker);
    try {
      const refreshed = await app.inject({ method: "POST", url: "/api/update-check/refresh" });
      expect(refreshed.statusCode).toBe(200);
      const body = refreshed.json<{ snapshot: { latestVersion: string; isNewer: boolean } | null }>();
      expect(body.snapshot?.latestVersion).toBe("0.6.0");
      expect(body.snapshot?.isNewer).toBe(true);

      const got = await app.inject({ method: "GET", url: "/api/update-check" });
      expect(got.statusCode).toBe(200);
      expect(got.json<{ snapshot: { latestVersion: string } }>().snapshot?.latestVersion).toBe("0.6.0");
    } finally {
      checker.close();
      await app.close();
    }
  });
});
