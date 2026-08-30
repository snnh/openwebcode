import path from "node:path";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer, type ServerDependencies } from "../src/app.js";
import type { CoreClient, CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import {
  MAX_WS_BUFFERED_BYTES,
  MAX_WS_BUFFERED_MESSAGES,
  isSlowClient,
} from "../src/events/ws-backpressure.js";
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
      const metrics = (await app.inject({ method: "GET", url: "/api/metrics" })).json();
      // core 桩无 stats（旧 core 兼容路径 → null）；node 恒有值；无扩展宿主 → null
      expect(metrics).toMatchObject({ events: events.stats(), websocket: { clients: 0, slowClientDisconnects: 0, failedClientSends: 0 } });
      expect(metrics.memory.node.rss).toBeGreaterThan(0);
      expect(metrics.memory.core).toBeNull();
      expect(metrics.memory.extensionHost).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("Metrics memory stats", () => {
  it("core.stats 可用时透传 rssBytes，无宿主时 extensionHost 为 null", async () => {
    const root = await tempRoot("owc-metrics-mem-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = {
      on() { return core; },
      async configureSession() { return {}; },
      async ping() { return { version: "test" }; },
      async stats() { return { rssBytes: 4 * 1024 * 1024 }; },
    } as unknown as CoreClientLike;
    const app = await buildServer({
      core,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      webDist: path.join(root, "web"),
    });
    apps.push(app as never);
    const metrics = (await app.inject({ method: "GET", url: "/api/metrics" })).json();
    expect(metrics.memory.core).toEqual({ rssBytes: 4 * 1024 * 1024 });
    expect(metrics.memory.extensionHost).toBeNull();
    expect(metrics.memory.node.rss).toBeGreaterThan(0);
  });

  it("core.stats 抛错时降级为 null（不阻断 metrics）", async () => {
    const root = await tempRoot("owc-metrics-mem-fail-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = {
      on() { return core; },
      async configureSession() { return {}; },
      async ping() { return { version: "test" }; },
      async stats() { throw new Error("core.stats unavailable"); },
    } as unknown as CoreClientLike;
    const app = await buildServer({
      core,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      webDist: path.join(root, "web"),
    });
    apps.push(app as never);
    const metrics = (await app.inject({ method: "GET", url: "/api/metrics" })).json();
    expect(metrics.memory.core).toBeNull();
    expect(metrics.memory.node.rss).toBeGreaterThan(0);
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

describe("慢客户端背压判定（单元）", () => {
  it("字节或消息数任一超限即判定为慢客户端", () => {
    expect(isSlowClient({ bufferedAmount: 0, pendingSends: 0 })).toBe(false);
    expect(isSlowClient({ bufferedAmount: MAX_WS_BUFFERED_BYTES, pendingSends: 0 })).toBe(false);
    expect(isSlowClient({ bufferedAmount: MAX_WS_BUFFERED_BYTES + 1, pendingSends: 0 })).toBe(true);
    expect(isSlowClient({ bufferedAmount: 0, pendingSends: MAX_WS_BUFFERED_MESSAGES + 1 })).toBe(true);
    // 覆盖阈值（测试/定制）生效
    const limits = { maxBufferedBytes: 10, maxBufferedMessages: 2 };
    expect(isSlowClient({ bufferedAmount: 11, pendingSends: 0 }, limits)).toBe(true);
    expect(isSlowClient({ bufferedAmount: 0, pendingSends: 3 }, limits)).toBe(true);
    expect(isSlowClient({ bufferedAmount: 10, pendingSends: 2 }, limits)).toBe(false);
  });
});

describe("慢 WS 客户端背压 enforcement（集成）", () => {
  it("会话订阅的实时过滤与回放一致，不混入其他会话的运行状态", async () => {
    const { WebSocket } = await import("ws");
    const stubCore = { on() { return stubCore; } } as unknown as CoreClient;
    const root = await tempRoot("owc-ws-scope-");
    const sessions = new SessionStore(path.join(root, ".sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const app = await buildServer({
      core: stubCore,
      sessions,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      events,
      providers: new ProviderRegistry(),
      pricing,
    });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = typeof address === "object" && address ? `ws://127.0.0.1:${address.port}` : "";
    const socket = new WebSocket(`${base}/api/events?sessionId=target`);
    const received: AppEvent[] = [];
    let connectedResolve: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => { connectedResolve = resolve; });
    socket.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString()) as AppEvent;
      if (event.type === "connected") connectedResolve?.();
      else received.push(event);
    });
    await connected;

    events.publish({ source: "agent", sessionId: "other", type: "agent.state", payload: { marker: "foreign" } });
    events.publish({ source: "agent", sessionId: "other", type: "run.started", payload: { marker: "foreign-run" } });
    events.publish({ source: "server", type: "models.updated", payload: { marker: "global" } });
    events.publish({ source: "agent", sessionId: "target", type: "agent.state", payload: { marker: "own" } });

    await new Promise<void>((resolve) => {
      const check = () => (received.length >= 2 ? resolve() : setTimeout(check, 10));
      check();
    });
    expect(received.map((event) => (event.payload as { marker?: string }).marker)).toEqual(["global", "own"]);
    socket.close();
  }, 20_000);

  it("慢客户端被补发 resync.required 后以 1013 断连，健康客户端照常收事件", async () => {
    const { WebSocket } = await import("ws");
    const stubCore = { on() { return stubCore; } } as unknown as CoreClient;
    const root = await tempRoot("owc-ws-bp-");
    const sessions = new SessionStore(path.join(root, ".sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    // 用待发送消息数稳定触发背压；字节阈值已由上面的纯函数测试覆盖。
    // 不依赖 runner 的 TCP 接收窗口大小，避免约 2MB 数据仍被内核接收时超时。
    const deps: ServerDependencies = {
      core: stubCore,
      sessions,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      events,
      providers,
      pricing,
      wsBackpressureLimits: { maxBufferedMessages: 1 },
    };
    const app = await buildServer(deps);
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = typeof address === "object" && address ? `ws://127.0.0.1:${address.port}` : "";

    // 慢客户端：握手成功后立即 pause 底层 socket，模拟永不读的消费端
    const slow = new WebSocket(`${base}/api/events?sessionId=slow-client`);
    const slowMessages: AppEvent[] = [];
    let slowCloseCode = 0;
    slow.on("message", (data: Buffer) => slowMessages.push(JSON.parse(data.toString()) as AppEvent));
    const slowClosed = new Promise<void>((resolve) => slow.on("close", (code: number) => { slowCloseCode = code; resolve(); }));
    await new Promise<void>((resolve) => slow.on("open", resolve));
    (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();

    // 健康客户端：正常读取
    const healthy = new WebSocket(`${base}/api/events?sessionId=healthy-client`);
    const healthyTypes: string[] = [];
    const healthyGot = (count: number) => new Promise<void>((resolve) => {
      const check = () => (healthyTypes.length >= count ? resolve() : setTimeout(check, 10));
      check();
    });
    healthy.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString()) as AppEvent;
      if (event.type !== "connected") healthyTypes.push(event.type);
    });
    await new Promise<void>((resolve) => healthy.on("open", resolve));

    // 同步发布时 send callback 尚未运行：第三条事件观察到两条待发送消息，
    // 确定性触发慢客户端路径。会话过滤保证健康客户端不接收这组洪峰。
    for (let i = 0; i < 3; i++) {
      events.publish({ source: "server", sessionId: "slow-client", type: `flood-${i}`, payload: "x" });
    }

    // 恢复读取：应能收到断连前补发的 resync.required，然后连接被关闭
    (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket.resume();
    await slowClosed;
    expect(slowCloseCode).toBe(1013);
    const resync = slowMessages.find((event) => event.type === "resync.required");
    expect(resync).toBeDefined();
    expect((resync!.payload as { reason?: string }).reason).toBe("slow_client");

    // 慢客户端已从 clients 移除并计入指标；健康客户端不受影响，仍在收事件
    const metrics = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(metrics.json().websocket.slowClientDisconnects).toBeGreaterThanOrEqual(1);
    events.publish({ source: "server", sessionId: "healthy-client", type: "after-disconnect", payload: null });
    await healthyGot(1);
    await new Promise<void>((resolve) => {
      const check = () => (healthyTypes.includes("after-disconnect") ? resolve() : setTimeout(check, 10));
      check();
    });
    healthy.close();
  }, 20_000);
});

describe("POST /messages body limit", () => {
  it("routes an image envelope over the 1 MiB global limit to image validation", async () => {
    const root = await tempRoot("owc-message-limit-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "text-only", title: "Body limit" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });

    try {
      // A valid base64 alphabet payload slightly above Fastify's 1 MiB global
      // default. The text-only model causes a semantic 400 after parsing;
      // without the route-specific limit this would instead be a 413.
      const payload = JSON.stringify({
        content: "large image envelope",
        images: [{ mediaType: "image/png", data: "A".repeat(1024 * 1024 + 16 * 1024) }],
      });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);

      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("不支持图片");

      // The old alphabet-only predicate admitted impossible padding. Keep the
      // malformed payload on the normal-sized path so this asserts semantic
      // validation rather than a body-limit response.
      for (const data of ["A===", "AB=="]) {
        const malformed = await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/messages`,
          payload: { content: "malformed image", images: [{ mediaType: "image/png", data }] },
        });
        expect(malformed.statusCode, malformed.body).toBe(400);
        expect(malformed.json<{ error: string }>().error).toContain("images");
      }
    } finally {
      await app.close();
    }
  });
});
