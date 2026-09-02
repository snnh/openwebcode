import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildAccessUrls, listLanAddresses, regenerateAccessToken, resolveAccessToken } from "../src/access-token.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer, sanitizeRequestUrl } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { defaultSandboxPolicy } from "../src/sessions/default-sandbox.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

function connectWebSocket(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; connected?: unknown; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("message", (data) => resolve({ socket, connected: JSON.parse(String(data)) }));
    socket.once("close", (closeCode) => resolve({ socket, closeCode }));
    socket.once("error", reject);
  });
}

describe("remote listener security", () => {
  it("非回环监听缺省自动生成令牌并同源放行；显式短 token 仍拒绝", () => {
    // 未显式 token/origins：不再拒绝启动（启动流程自动生成 token），同源自动放行置位
    const auto = loadConfig({ OWC_HOST: "0.0.0.0" });
    expect(auto).toMatchObject({ host: "0.0.0.0", allowedOrigins: [], autoAllowSameOrigin: true });
    expect(auto.accessToken).toBeUndefined();
    // 显式短 token：仍拒绝
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0", OWC_ACCESS_TOKEN: "short" })).toThrow(/OWC_ACCESS_TOKEN/);
    // 显式 origins：维持严格列表，不置同源放行
    const strict = loadConfig({
      OWC_HOST: "0.0.0.0",
      OWC_ACCESS_TOKEN: "a".repeat(32),
      OWC_ALLOWED_ORIGINS: "https://owc.example.test",
    });
    expect(strict).toMatchObject({ host: "0.0.0.0", allowedOrigins: ["https://owc.example.test"] });
    expect(strict.autoAllowSameOrigin).toBeUndefined();
  });

  it("requires the configured token for every API route", async () => {
    const root = await tempRoot("owc-security-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const token = `${"t".repeat(30)};=`;
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      auth: { accessToken: token, allowedOrigins: ["https://owc.example.test"] },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ status: "ok" });
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-openwebcode-token": "wrong" } })).statusCode).toBe(401);

      const bootstrap = await app.inject({ method: "GET", url: `/?token=${encodeURIComponent(token)}` });
      expect(bootstrap.statusCode).toBe(302);
      expect(bootstrap.headers.location).toBe("/");
      expect(bootstrap.headers["set-cookie"]).toContain("HttpOnly");
      expect(bootstrap.headers["set-cookie"]).toContain(encodeURIComponent(token));
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { cookie } })).statusCode).toBe(200);
      expect(sanitizeRequestUrl(`/?token=${encodeURIComponent(token)}&next=1`)).toBe("/?token=%5BREDACTED%5D&next=1");

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
      const url = `ws://127.0.0.1:${address.port}/api/events`;
      const denied = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: "https://other.example.test" });
      expect(denied.closeCode).toBe(1008);

      const accepted = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: "https://owc.example.test" });
      expect(accepted.connected).toMatchObject({ type: "connected" });
      accepted.socket.close();
    } finally {
      await app.close();
    }
  });
});

describe("default sandbox denyPaths", () => {
  it("新建会话默认拒绝覆写 .env 与 .owc/hooks.json、.owc/mcp.json（宿主执行入口）", async () => {
    const root = await tempRoot("owc-security-");
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
    const root = await tempRoot("owc-security-");
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

  it("HTTP 与 WS 均拒绝非本机 Host，WS 另拒绝非本机 Origin", async () => {
    const app = await buildNoAuthApp();
    try {
      const reboundHttp = await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example.test" } });
      expect(reboundHttp.statusCode).toBe(403);
      expect(reboundHttp.json()).toEqual({ error: "Loopback mode requires a loopback Host header" });
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:3000" } })).statusCode).toBe(200);

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

describe("same-origin auto-allow (autoAllowSameOrigin)", () => {
  it("放行与请求 Host 同源的浏览器 Origin，拒绝不同源与伪造 Host", async () => {
    const root = await tempRoot("owc-security-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const token = "s".repeat(32);
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      auth: { accessToken: token, allowedOrigins: [], autoAllowSameOrigin: true },
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
      const url = `ws://127.0.0.1:${address.port}/api/events`;

      // 与请求 Host 同源的 Origin：放行
      const sameOrigin = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${address.port}` });
      expect(sameOrigin.connected).toMatchObject({ type: "connected" });
      sameOrigin.socket.close();

      // 端口不同即不同源：拒绝
      const otherPort = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:9999" });
      expect(otherPort.closeCode).toBe(1008);

      // 伪造 Host 使 Origin 与之不同源：拒绝
      const spoofed = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${address.port}`, host: "evil.example.test" });
      expect(spoofed.closeCode).toBe(1008);

      // 显式列表关闭同源放行后，同源 Origin 也拒绝
      const strict = await buildServer({
        core: {} as CoreClient,
        sessions,
        agent: { isRunning: () => false } as AgentRunner,
        events: new EventBus(),
        providers: new ProviderRegistry(),
        pricing,
        auth: { accessToken: token, allowedOrigins: ["https://owc.example.test"] },
      });
      try {
        await strict.listen({ host: "127.0.0.1", port: 0 });
        const strictAddress = strict.server.address();
        if (!strictAddress || typeof strictAddress === "string") throw new Error("test server did not expose a TCP address");
        const denied = await connectWebSocket(`ws://127.0.0.1:${strictAddress.port}/api/events`, { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${strictAddress.port}` });
        expect(denied.closeCode).toBe(1008);
      } finally {
        await strict.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe("/api/remote-access", () => {
  async function buildRemoteAccessApp(options: { tokenSource: "env" | "generated"; withRegenerate?: boolean }) {
    const root = await tempRoot("owc-security-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const token = "a".repeat(64);
    const nextToken = "b".repeat(64);
    const authState = { accessToken: token, allowedOrigins: [] as string[], autoAllowSameOrigin: true };
    const state = { regenerateCalls: 0, token, nextToken };
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      auth: authState,
      remoteAccess: {
        host: "0.0.0.0",
        port: 3000,
        tokenSource: options.tokenSource,
        lanAddresses: ["192.168.1.5"],
        ...(options.withRegenerate
          ? {
              regenerate: async () => {
                state.regenerateCalls += 1;
                authState.accessToken = nextToken;
                return nextToken;
              },
            }
          : {}),
      },
    });
    return { app, state };
  }

  it("供数访问链接；自动生成令牌可再生成且旧令牌立即失效", async () => {
    const { app, state } = await buildRemoteAccessApp({ tokenSource: "generated", withRegenerate: true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/remote-access" })).statusCode).toBe(401);
      const info = await app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${state.token}` } });
      expect(info.statusCode).toBe(200);
      expect(info.json()).toEqual({
        host: "0.0.0.0",
        port: 3000,
        authEnabled: true,
        tokenSource: "generated",
        maskedToken: `${state.token.slice(0, 7)}…${state.token.slice(-4)}`,
        urls: [`http://192.168.1.5:3000/?token=${state.token}`],
      });
      const regenerated = await app.inject({ method: "POST", url: "/api/remote-access/regenerate-token", headers: { authorization: `Bearer ${state.token}` } });
      expect(regenerated.statusCode).toBe(200);
      expect(state.regenerateCalls).toBe(1);
      expect(regenerated.json().urls).toEqual([`http://192.168.1.5:3000/?token=${state.nextToken}`]);
      expect(regenerated.json().note).toContain("失效");
      expect((await app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${state.token}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${state.nextToken}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("env 显式令牌不提供再生成（409），链接仍可供数", async () => {
    const { app, state } = await buildRemoteAccessApp({ tokenSource: "env" });
    try {
      const info = await app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${state.token}` } });
      expect(info.statusCode).toBe(200);
      expect(info.json().tokenSource).toBe("env");
      expect(info.json().urls).toEqual([`http://192.168.1.5:3000/?token=${state.token}`]);
      const regenerated = await app.inject({ method: "POST", url: "/api/remote-access/regenerate-token", headers: { authorization: `Bearer ${state.token}` } });
      expect(regenerated.statusCode).toBe(409);
      expect(state.regenerateCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("access-token store", () => {
  it("首次生成 64 位 hex 并持久化；再次解析复用同一令牌", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const first = await resolveAccessToken({ filePath });
    expect(first.source).toBe("generated");
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(filePath, "utf8")).trim()).toBe(first.token);
    const second = await resolveAccessToken({ filePath });
    expect(second).toEqual(first);
  });

  it("POSIX 下令牌文件为 0600", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    await resolveAccessToken({ filePath });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("显式 env token 优先且不写文件；过短 env token 拒绝", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const envToken = "e".repeat(32);
    const resolved = await resolveAccessToken({ envToken, filePath });
    expect(resolved).toEqual({ token: envToken, source: "env" });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await expect(resolveAccessToken({ envToken: "short", filePath })).rejects.toThrow(/at least 32/);
  });

  it("文件内容损坏时重新生成并覆盖", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    await writeFile(filePath, "corrupted\n", "utf8");
    const resolved = await resolveAccessToken({ filePath });
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(filePath, "utf8")).trim()).toBe(resolved.token);
  });

  it("regenerate 产出新令牌并持久化", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const first = await resolveAccessToken({ filePath });
    const next = await regenerateAccessToken(filePath);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(first.token);
    expect((await resolveAccessToken({ filePath })).token).toBe(next);
  });
});

describe("buildAccessUrls", () => {
  const token = "t".repeat(64);
  it("buildAccessUrls：地址/通配展开/IPv6", () => {
    expect(buildAccessUrls("192.168.1.5", 3000, [], token)).toEqual([`http://192.168.1.5:3000/?token=${token}`]);
    expect(buildAccessUrls("fd00::1", 3000, [], token)).toEqual([`http://[fd00::1]:3000/?token=${token}`]);
    expect(buildAccessUrls("0.0.0.0", 3000, ["10.0.0.2", "192.168.1.5"], token)).toEqual([
      `http://10.0.0.2:3000/?token=${token}`,
      `http://192.168.1.5:3000/?token=${token}`,
    ]);
    expect(buildAccessUrls("0.0.0.0", 3000, [], token)).toEqual([`http://0.0.0.0:3000/?token=${token}`]);
  });
  it("listLanAddresses 返回字符串数组（本机可能为空）", () => {
    const addresses = listLanAddresses();
    expect(Array.isArray(addresses)).toBe(true);
    for (const address of addresses) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
