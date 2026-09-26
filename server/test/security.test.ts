import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import os from "node:os";
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
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

function connectWebSocket(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; connected?: unknown; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("message", (data) => resolve({ socket, connected: JSON.parse(String(data)) }));
    socket.once("close", (closeCode) => resolve({ socket, closeCode }));
    socket.once("error", reject);
  });
}

/** 无托管/无扩展的最小 app（可选注入 auth/remoteAccess 覆盖）。 */
async function securityApp(overrides: Partial<Pick<Parameters<typeof buildServer>[0], "auth" | "remoteAccess">> = {}) {
  const root = await tempRoot("owc-security-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const app = await buildServer({
    core: {} as CoreClient, sessions, pricing, events: new EventBus(), providers: new ProviderRegistry(),
    agent: { isRunning: () => false } as AgentRunner, ...overrides,
  });
  return { app, sessions, root };
}

/** 起监听并返回 events WS 地址与对应 http Origin。 */
async function listen(app: FastifyInstance): Promise<{ url: string; origin: string }> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return { url: `ws://127.0.0.1:${address.port}/api/events`, origin: `http://127.0.0.1:${address.port}` };
}

describe("remote listener security", () => {
  it("非回环监听缺省自动生成令牌并同源放行；显式短 token 仍拒绝、显式 origins 严格", () => {
    const auto = loadConfig({ OWC_HOST: "0.0.0.0" }); expect(auto).toMatchObject({ host: "0.0.0.0", allowedOrigins: [], autoAllowSameOrigin: true }); expect(auto.accessToken).toBeUndefined();
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0", OWC_ACCESS_TOKEN: "short" })).toThrow(/OWC_ACCESS_TOKEN/);
    const strict = loadConfig({ OWC_HOST: "0.0.0.0", OWC_ACCESS_TOKEN: "a".repeat(32), OWC_ALLOWED_ORIGINS: "https://owc.example.test" });
    expect(strict).toMatchObject({ host: "0.0.0.0", allowedOrigins: ["https://owc.example.test"] }); expect(strict.autoAllowSameOrigin).toBeUndefined();
  });

  it("每个 API 路由都要 token；bootstrap cookie 放行；WS 另判 Origin", async () => {
    const token = `${"t".repeat(30)};=`;
    const { app } = await securityApp({ auth: { accessToken: token, allowedOrigins: ["https://owc.example.test"] } });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ status: "ok" });
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-openwebcode-token": "wrong" } })).statusCode).toBe(401);
      const bootstrap = await app.inject({ method: "GET", url: `/?token=${encodeURIComponent(token)}` }); expect(bootstrap.statusCode).toBe(302); expect(bootstrap.headers.location).toBe("/");
      expect(bootstrap.headers["set-cookie"]).toContain("HttpOnly"); expect(bootstrap.headers["set-cookie"]).toContain(encodeURIComponent(token));
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]; expect((await app.inject({ method: "GET", url: "/api/health", headers: { cookie } })).statusCode).toBe(200);
      expect(sanitizeRequestUrl(`/?token=${encodeURIComponent(token)}&next=1`)).toBe("/?token=%5BREDACTED%5D&next=1");
      const { url } = await listen(app);
      const denied = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: "https://other.example.test" }); expect(denied.closeCode).toBe(1008);
      const accepted = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin: "https://owc.example.test" }); expect(accepted.connected).toMatchObject({ type: "connected" });
      accepted.socket.close();
    } finally {
      await app.close();
    }
  });
});

describe("默认沙盒 denyPaths", () => {
  it("新建会话默认拒绝覆写 .env 与 .owc/hooks.json、.owc/mcp.json（宿主执行入口）", async () => {
    const { sessions, root } = await securityApp();
    const cwd = path.join(root, "work");
    const created = await sessions.create({ cwd, provider: "p", model: "m" });
    const resolved = path.resolve(cwd); expect(created.sandbox?.denyPaths).toEqual([path.join(resolved, ".env"), path.join(resolved, ".owc", "hooks.json"), path.join(resolved, ".owc", "mcp.json")]);
    expect(defaultSandboxPolicy(cwd).denyPaths).toEqual(created.sandbox?.denyPaths); // 会话无持久化 sandbox 时的回退同样带清单
  });
});

describe("Host/Origin 同源策略", () => {
  it("loopback 模式拒绝非本机 Host/Origin；autoAllowSameOrigin 放行同源、显式列表不置位", async () => {
    const loopback = await securityApp();
    try {
      const rebound = await loopback.app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example.test" } }); expect(rebound.statusCode).toBe(403);
      expect(rebound.json()).toEqual({ error: "Loopback mode requires a loopback Host header" });
      expect((await loopback.app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:3000" } })).statusCode).toBe(200);
      const { url, origin } = await listen(loopback.app);
      // 跨域 Origin / 非 http(s) Origin / DNS rebinding 形态的 Host：拒绝
      for (const headers of [{ origin: "https://evil.example.test" }, { origin: "file:///tmp/x" }, { host: "evil.example.test" }]) {
        expect((await connectWebSocket(url, headers)).closeCode, JSON.stringify(headers)).toBe(1008);
      }
      // loopback Origin（本地 UI）+ localhost Origin + 无 Origin 的非浏览器客户端：放行
      for (const headers of [{ origin }, { origin: "http://localhost:3210" }, {}]) {
        const opened = await connectWebSocket(url, headers); expect(opened.connected).toMatchObject({ type: "connected" });
        opened.socket.close();
      }
    } finally {
      await loopback.app.close();
    }
    const token = "s".repeat(32);
    const sameOrigin = await securityApp({ auth: { accessToken: token, allowedOrigins: [], autoAllowSameOrigin: true } });
    try {
      const { url, origin } = await listen(sameOrigin.app);
      const opened = await connectWebSocket(url, { authorization: `Bearer ${token}`, origin }); expect(opened.connected).toMatchObject({ type: "connected" });
      opened.socket.close();
      // 端口不同即不同源；伪造 Host 使 Origin 与之不同源：均拒绝
      for (const headers of [
        { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:9999" },
        { authorization: `Bearer ${token}`, origin, host: "evil.example.test" },
      ]) {
        expect((await connectWebSocket(url, headers)).closeCode).toBe(1008);
      }
    } finally {
      await sameOrigin.app.close();
    }
    // 显式 origins 时同源放行关闭：同源 Origin 也拒绝
    const strict = await securityApp({ auth: { accessToken: token, allowedOrigins: ["https://owc.example.test"] } });
    try {
      const { url, origin } = await listen(strict.app); expect((await connectWebSocket(url, { authorization: `Bearer ${token}`, origin })).closeCode).toBe(1008);
    } finally {
      await strict.app.close();
    }
  }, 20_000);
});

describe("/api/remote-access", () => {
  async function remoteAccessApp(tokenSource: "env" | "generated", withRegenerate = false) {
    const token = "a".repeat(64);
    const nextToken = "b".repeat(64);
    const auth = { accessToken: token, allowedOrigins: [] as string[], autoAllowSameOrigin: true };
    let regenerateCalls = 0;
    const { app } = await securityApp({
      auth,
      remoteAccess: {
        host: "0.0.0.0", port: 3000, tokenSource, lanAddresses: ["192.168.1.5"],
        ...(withRegenerate ? { regenerate: async () => { regenerateCalls += 1; auth.accessToken = nextToken; return nextToken; } } : {}),
      },
    });
    return { app, token, nextToken, regenerateCalls: () => regenerateCalls };
  }
  it("供数访问链接与掩码；generated 可再生成且旧令牌立即失效，env 令牌 409", async () => {
    const generated = await remoteAccessApp("generated", true);
    try {
      expect((await generated.app.inject({ method: "GET", url: "/api/remote-access" })).statusCode).toBe(401);
      const info = await generated.app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${generated.token}` } }); expect(info.json()).toEqual({
        host: "0.0.0.0",
        port: 3000,
        authEnabled: true,
        tokenSource: "generated",
        maskedToken: `${generated.token.slice(0, 7)}…${generated.token.slice(-4)}`,
        urls: [`http://192.168.1.5:3000/?token=${generated.token}`],
      });
      const regenerated = await generated.app.inject({ method: "POST", url: "/api/remote-access/regenerate-token", headers: { authorization: `Bearer ${generated.token}` } });
      expect(regenerated.statusCode).toBe(200); expect(generated.regenerateCalls()).toBe(1); expect(regenerated.json().urls).toEqual([`http://192.168.1.5:3000/?token=${generated.nextToken}`]);
      expect(regenerated.json().note).toContain("失效");
      expect((await generated.app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${generated.token}` } })).statusCode).toBe(401);
      expect((await generated.app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${generated.nextToken}` } })).statusCode).toBe(200);
    } finally {
      await generated.app.close();
    }
    const env = await remoteAccessApp("env");
    try {
      const info = await env.app.inject({ method: "GET", url: "/api/remote-access", headers: { authorization: `Bearer ${env.token}` } }); expect(info.statusCode).toBe(200);
      expect(info.json()).toMatchObject({ tokenSource: "env", urls: [`http://192.168.1.5:3000/?token=${env.token}`] });
      expect((await env.app.inject({ method: "POST", url: "/api/remote-access/regenerate-token", headers: { authorization: `Bearer ${env.token}` } })).statusCode).toBe(409);
      expect(env.regenerateCalls()).toBe(0);
    } finally {
      await env.app.close();
    }
  });
});

describe("access-token store", () => {
  it("生成 64 位 hex 并持久化、再次解析复用、POSIX 0600、损坏重生成、regenerate；env token 优先且过短拒绝", async () => {
    const filePath = path.join(await tempRoot("owc-access-token-"), "access-token");
    const first = await resolveAccessToken({ filePath }); expect(first).toMatchObject({ source: "generated" }); expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(filePath, "utf8")).trim()).toBe(first.token); expect(await resolveAccessToken({ filePath })).toEqual(first);
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await writeFile(filePath, "corrupted\n", "utf8");
    const repaired = await resolveAccessToken({ filePath }); expect(repaired.token).toMatch(/^[0-9a-f]{64}$/); expect((await readFile(filePath, "utf8")).trim()).toBe(repaired.token);
    const next = await regenerateAccessToken(filePath); expect(next).toMatch(/^[0-9a-f]{64}$/); expect(next).not.toBe(repaired.token);
    expect((await resolveAccessToken({ filePath })).token).toBe(next);
    const envPath = path.join(await tempRoot("owc-access-token-"), "access-token");
    const envToken = "e".repeat(32); expect(await resolveAccessToken({ envToken, filePath: envPath })).toEqual({ token: envToken, source: "env" });
    await expect(readFile(envPath, "utf8")).rejects.toThrow();
    await expect(resolveAccessToken({ envToken: "short", filePath: envPath })).rejects.toThrow(/at least 32/);
  });
});

describe("buildAccessUrls", () => {
  it("地址/通配展开/IPv6；listLanAddresses 返回字符串数组", () => {
    const token = "t".repeat(64); expect(buildAccessUrls("192.168.1.5", 3000, [], token)).toEqual([`http://192.168.1.5:3000/?token=${token}`]);
    expect(buildAccessUrls("fd00::1", 3000, [], token)).toEqual([`http://[fd00::1]:3000/?token=${token}`]); expect(buildAccessUrls("0.0.0.0", 3000, ["10.0.0.2", "192.168.1.5"], token)).toEqual([
      `http://10.0.0.2:3000/?token=${token}`,
      `http://192.168.1.5:3000/?token=${token}`,
    ]);
    expect(buildAccessUrls("0.0.0.0", 3000, [], token)).toEqual([`http://0.0.0.0:3000/?token=${token}`]);
    const addresses = listLanAddresses(); expect(Array.isArray(addresses)).toBe(true);
    for (const address of addresses) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("WebUI 静态服务", () => {
  it("index 安全响应头；散列资产走 .br 同伴 + immutable 强缓存，入口保持重验", async () => {
    const webDist = path.join(await tempRoot("owc-static-"), "dist");
    await mkdir(path.join(webDist, "assets"), { recursive: true });
    const js = `console.log(${JSON.stringify("x".repeat(2048))});`;
    await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>owc</title>", "utf8");
    await writeFile(path.join(webDist, "assets", "app-A1B2C3.js"), js, "utf8");
    await writeFile(path.join(webDist, "assets", "app-A1B2C3.js.br"), brotliCompressSync(js), undefined as never);
    const { app } = await makeTestApp({ webDist });
    try {
      const page = await app.inject({ method: "GET", url: "/" }); expect(page.headers["x-frame-options"]).toBe("DENY"); expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect(page.headers["x-content-type-options"]).toBe("nosniff"); expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(String(page.headers["content-security-policy"])).toContain("default-src 'self'"); expect(page.headers["cache-control"]).toBe("no-cache");
      const asset = await app.inject({ method: "GET", url: "/assets/app-A1B2C3.js", headers: { "accept-encoding": "br" } }); expect(asset.headers["content-encoding"]).toBe("br");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      // inject 不做内容协商解压：确认发出去的确实是原文件的 br 同伴
      expect(brotliDecompressSync(asset.rawPayload).toString("utf8")).toBe(js);
    } finally {
      await app.close();
    }
  });
});

describe("API 响应压缩", () => {
  it("大 JSON 响应按 br 压缩，小响应不压", async () => {
    const { app, sessions } = await makeTestApp();
    try {
      const session = await sessions.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
      await sessions.appendMessage(session.id, { role: "assistant", content: "x".repeat(8 * 1024) });
      const big = await app.inject({ method: "GET", url: `/api/sessions/${session.id}`, headers: { "accept-encoding": "br" } }); expect(big.headers["content-encoding"]).toBe("br");
      expect(big.headers["vary"]).toBe("accept-encoding"); expect(JSON.parse(brotliDecompressSync(big.rawPayload).toString("utf8")).messages.length).toBe(1);
      const small = await app.inject({ method: "GET", url: "/api/sessions", headers: { "accept-encoding": "br" } }); expect(small.headers["content-encoding"]).toBeUndefined(); // 低于阈值不压
    } finally {
      await app.close();
    }
  });
});
