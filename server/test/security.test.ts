import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { defaultSandboxPolicy } from "../src/sessions/default-sandbox.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function connectWebSocket(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; connected?: unknown; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("message", (data) => resolve({ socket, connected: JSON.parse(String(data)) }));
    socket.once("close", (closeCode) => resolve({ socket, closeCode }));
    socket.once("error", reject);
  });
}

describe("remote listener security", () => {
  it("refuses a non-loopback listener without a strong token and explicit origins", () => {
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0" })).toThrow(/OWC_ACCESS_TOKEN/);
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0", OWC_ACCESS_TOKEN: "a".repeat(32) })).toThrow(/OWC_ALLOWED_ORIGINS/);
    expect(loadConfig({
      OWC_HOST: "0.0.0.0",
      OWC_ACCESS_TOKEN: "a".repeat(32),
      OWC_ALLOWED_ORIGINS: "https://owc.example.test",
    })).toMatchObject({ host: "0.0.0.0", allowedOrigins: ["https://owc.example.test"] });
  });

  it("requires the configured token for every API route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-security-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      auth: { accessToken: "t".repeat(32), allowedOrigins: ["https://owc.example.test"] },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { authorization: `Bearer ${"t".repeat(32)}` } })).json()).toEqual({ status: "ok" });
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-openwebcode-token": "wrong" } })).statusCode).toBe(401);

      const bootstrap = await app.inject({ method: "GET", url: `/?token=${"t".repeat(32)}` });
      expect(bootstrap.statusCode).toBe(302);
      expect(bootstrap.headers.location).toBe("/");
      expect(bootstrap.headers["set-cookie"]).toContain("HttpOnly");

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
      const url = `ws://127.0.0.1:${address.port}/api/events`;
      const denied = await connectWebSocket(url, { authorization: `Bearer ${"t".repeat(32)}`, origin: "https://other.example.test" });
      expect(denied.closeCode).toBe(1008);

      const accepted = await connectWebSocket(url, { authorization: `Bearer ${"t".repeat(32)}`, origin: "https://owc.example.test" });
      expect(accepted.connected).toMatchObject({ type: "connected" });
      accepted.socket.close();
    } finally {
      await app.close();
    }
  });
});

describe("default sandbox denyPaths", () => {
  it("新建会话默认拒绝覆写 .env 与 .owc/hooks.json、.owc/mcp.json（宿主执行入口）", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-security-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const cwd = path.join(root, "work");
    const created = await sessions.create({ cwd, provider: "p", model: "m" });
    expect(created.sandbox?.denyPaths).toEqual([
      path.join(path.resolve(cwd), ".env"),
      path.join(path.resolve(cwd), ".owc", "hooks.json"),
      path.join(path.resolve(cwd), ".owc", "mcp.json"),
    ]);
    // 缺省回退（会话无持久化 sandbox 时）同样带拒绝清单
    expect(defaultSandboxPolicy(cwd).denyPaths).toEqual(created.sandbox?.denyPaths);
  });
});

describe("no-auth loopback WebSocket origin policy", () => {
  async function buildNoAuthApp(): Promise<FastifyInstance> {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-security-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    return buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
    });
  }

  it("拒绝非本机 Origin/Host，放行 loopback Origin 与无 Origin 客户端", async () => {
    const app = await buildNoAuthApp();
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
      const url = `ws://127.0.0.1:${address.port}/api/events`;

      // 任意网页的跨域 Origin：拒绝
      const crossSite = await connectWebSocket(url, { origin: "https://evil.example.test" });
      expect(crossSite.closeCode).toBe(1008);

      // 非 http(s) Origin：拒绝
      const weirdScheme = await connectWebSocket(url, { origin: "file:///tmp/x" });
      expect(weirdScheme.closeCode).toBe(1008);

      // 伪造非本机 Host（DNS rebinding 形态）：拒绝
      const badHost = await connectWebSocket(url, { host: "evil.example.test" });
      expect(badHost.closeCode).toBe(1008);

      // loopback Origin（本地 UI）：放行
      const loopback = await connectWebSocket(url, { origin: `http://127.0.0.1:${address.port}` });
      expect(loopback.connected).toMatchObject({ type: "connected" });
      loopback.socket.close();
      const localhost = await connectWebSocket(url, { origin: "http://localhost:3210" });
      expect(localhost.connected).toMatchObject({ type: "connected" });
      localhost.socket.close();

      // 无 Origin 的非浏览器客户端（CLI）：放行
      const cli = await connectWebSocket(url, {});
      expect(cli.connected).toMatchObject({ type: "connected" });
      cli.socket.close();
    } finally {
      await app.close();
    }
  });
});
