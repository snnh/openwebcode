/**
 * dsh 端口服务单测：真实 Fastify 注入 + 真实 WS 连接。
 * vendor 缺失时整组跳过（CI 无网络也能跑门禁）。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildDshServer, type DshServer } from "../src/dsh/web-protocol/server.js";
import type { DshWireDeps } from "../src/dsh/web-protocol/streams.js";
import { EventBus } from "../src/events/event-bus.js";
import type { DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import type { SessionMeta } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR = path.join(SERVER_ROOT, "assets", "dsh-web");
const VENDOR_READY = existsSync(path.join(VENDOR, "manifest.json"));
const TOKEN = "test-token-123"; const COOKIE = { cookie: `owc_access_token=${TOKEN}` }; const servers: DshServer[] = [];

afterEach(async () => { while (servers.length > 0) await servers.pop()?.close(); });

function fakeDeps() {
  const metas = [{ id: "s1", cwd: "/work/proj", provider: "p", model: "m", title: "会话一", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z" } as SessionMeta];
  const projection = {
    sessions: {
      list: async () => metas, getMeta: async (id: string) => metas.find((entry) => entry.id === id),
      getTail: async (id: string) => (id === "s1" ? { ...metas[0], messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:05:00.000Z" }], hasMoreMessages: false } : undefined),
      get: async () => undefined, create: async () => metas[0] as never,
    },
    agent: { run: vi.fn(async () => {}), isRunning: () => false, abort: vi.fn(() => true) },
    defaultCwd: "/work/default",
  } as unknown as DshProjectionDeps;
  return { projection, events: new EventBus(), home: "/home/tester", respondPermission: vi.fn(async () => {}), respondInteraction: vi.fn(async () => {}), logger: { warn: () => {} } } as DshWireDeps & { respondPermission: ReturnType<typeof vi.fn> };
}

type StartOptions = { enabled?: () => boolean; accessToken?: string | undefined; vendor?: string; deps?: ReturnType<typeof fakeDeps>; bridgePlugin?: unknown; owcStatus?: unknown; totp?: unknown };

async function startServer(overrides: StartOptions = {}): Promise<{ server: DshServer; base: string; deps: ReturnType<typeof fakeDeps> }> {
  const deps = overrides.deps ?? fakeDeps();
  const server = await buildDshServer({
    vendorDirectory: overrides.vendor ?? VENDOR,
    enabled: overrides.enabled ?? (() => true),
    accessToken: () => ("accessToken" in overrides ? overrides.accessToken : TOKEN),
    deps,
    ...(overrides.bridgePlugin === undefined ? {} : { bridgePlugin: overrides.bridgePlugin }),
    ...(overrides.owcStatus === undefined ? {} : { owcStatus: overrides.owcStatus }),
    ...(overrides.totp === undefined ? {} : { totp: overrides.totp }),
    logger: { warn: () => {}, info: () => {} },
  } as never);
  expect(server).toBeDefined();
  const address = await (server as DshServer).listen("127.0.0.1", 0); servers.push(server as DshServer);
  return { server: server as DshServer, base: `http://${address}`, deps };
}

function unaryBody(method: string, args: Record<string, unknown>, rpcId = "r1"): string {
  return JSON.stringify({ type: "client-request", rpcId, method, payload: { args } });
}

/** unary 注入（dsh 要求 Content-Type essence 精确为 application/json）。 */
function unaryInject(server: DshServer, endpoint: string, body: string, token: string | undefined) {
  return server.app.inject({ method: "POST", url: `/api/${endpoint}`,
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { cookie: `owc_access_token=${token}` }) },
    payload: body,
  });
}

/** 打开一条 WS 并收集下行帧（调用方负责 close）。 */
async function openSocket(base: string, headers: Record<string, string> = COOKIE): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(`${base}/api/remote.mux`, { headers }); const frames: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return { socket, frames };
}

/** 升级被拒时的 HTTP 状态码（-1/-2 表示意外关闭/错误）。 */
function upgradeStatus(base: string, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/remote.mux`, { headers });
  return new Promise<number>((resolve, reject) => {
    socket.on("open", () => { socket.close(); reject(new Error("竟然握手成功")); });
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.on("error", (error) => reject(error));
  });
}

describe.skipIf(!VENDOR_READY)("dsh 端口服务（需 vendor）", () => {
  it("鉴权：未鉴权 API/index 401 且 WS 升级前被拒，静态与插件公开；cookie/bearer 放行，`/?token=` 换 cookie 并 303", async () => {
    const { server, base } = await startServer();
    const list = unaryBody("session/list", { _request: {} }); expect([(await unaryInject(server, "session/list", list, undefined)).statusCode, (await server.app.inject({ method: "GET", url: "/" })).statusCode]).toEqual([401, 401]); expect(await upgradeStatus(base, {})).toBe(401);
    // 插件 bundle 免鉴权可取（SHELL 加载顺序要求先于登录态）
    expect((await server.app.inject({ method: "GET", url: "/plugins/@deepseek-ai/dsh-client-ui-chat/client.js" })).statusCode).toBe(200);
    const withCookie = await unaryInject(server, "session/list", list, TOKEN); expect(withCookie.statusCode).toBe(200); expect(JSON.parse(withCookie.body)).toMatchObject({ type: "server-response", rpcId: "r1", result: { ok: true } });
    expect((await server.app.inject({ method: "POST", url: "/api/session/list", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, payload: list })).statusCode).toBe(200);
    const exchanged = await server.app.inject({ method: "GET", url: `/?token=${TOKEN}` }); expect([exchanged.statusCode, exchanged.headers["set-cookie"], exchanged.headers.location])
      .toEqual([303, expect.stringContaining(`owc_access_token=${TOKEN}`), "/"]);
  });
  it("回环免鉴权部署：非回环 Host 一律 403（index/API/assets），回环放行；WS 只放行回环 Origin", async () => {
    const { server, base } = await startServer({ accessToken: undefined });
    const evil = { host: "evil.example" }; expect([
      (await server.app.inject({ method: "GET", url: "/", headers: evil })).statusCode,
      (await server.app.inject({ method: "POST", url: "/api/session/list", headers: { "content-type": "application/json", ...evil }, payload: unaryBody("session/list", { _request: {} }) })).statusCode,
      (await server.app.inject({ method: "GET", url: "/assets/", headers: evil })).statusCode,
      (await server.app.inject({ method: "GET", url: "/", headers: { host: "127.0.0.1:3211" } })).statusCode,
    ]).toEqual([403, 403, 403, 200]);
    expect(await upgradeStatus(base, { origin: "https://evil.example" })).toBe(403); expect(await upgradeStatus(base, { origin: "http://127.0.0.1:5173" }).catch(() => 101)).not.toBe(403); // 放行时 helper 以 reject 表示握手成功
  });
  it("关闭开关：API/index/index.html 一律 503（含 dshCompatEnabled 提示）", async () => {
    const { server } = await startServer({ enabled: () => false });
    const api = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), TOKEN); expect([
      api.statusCode,
      (await server.app.inject({ method: "GET", url: "/", headers: COOKIE })).statusCode,
      (await server.app.inject({ method: "GET", url: "/index.html", headers: COOKIE })).statusCode,
    ]).toEqual([503, 503, 503]);
    // 不交出未注入 boot graph 的原始 index，也不能让客户端以为是「没实现」
    expect(JSON.parse(api.body)).toMatchObject({ error: expect.stringContaining("dshCompatEnabled") });
  });
  it("unary 投影：session/list 取真实投影；未知端点 method-unavailable、path/method 不一致 bad-request", async () => {
    const { server } = await startServer();
    const list = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), TOKEN); expect(JSON.parse(list.body)).toMatchObject({ result: { ok: true, value: { items: [{ sessionId: "s1" }] } } });
    expect(JSON.parse((await unaryInject(server, "session/nope", unaryBody("session/nope", {}), TOKEN)).body))
      .toMatchObject({ result: { ok: false, error: { code: "gateway/method-unavailable" } } });
    expect(JSON.parse((await unaryInject(server, "session/list", unaryBody("session/other", {}), TOKEN)).body))
      .toMatchObject({ result: { ok: false, error: { code: "gateway/bad-request" } } });
  });
  it("自渲染 index 注入 boot graph（模块系统 bootstrap、__DSH_BOOT__、就绪尾标），无 HEAD 的 vendor 目录同样可渲染", async () => {
    const { server } = await startServer();
    const response = await server.app.inject({ method: "GET", url: "/", headers: COOKIE }); expect(response.statusCode).toBe(200); expect(response.headers["content-type"]).toContain("text/html");
    for (const marker of ["window.__ModuleLoader__={", 'globalThis["__DSH_BOOT__"]', "<script src=\"/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=", "__DSH_BOOT_READY__", "<div id=\"root\">"]) {
      expect(response.body, marker).toContain(marker);
    }
    // 写盘 fixture：没有 HEAD 的 vendor 目录也必须自渲染（head 注入不依赖 git 产物）
    const custom = await mkdtemp(path.join(tmpdir(), "owc-dsh-vendor2-"));
    await mkdir(path.join(custom, "static"), { recursive: true });
    await mkdir(path.join(custom, "plugins", "@deepseek-ai", "dsh-client-modules"), { recursive: true });
    await writeFile(path.join(custom, "static", "index.html"), "<html><body><div id=root></div></body></html>");
    await writeFile(path.join(custom, "plugins", "@deepseek-ai", "dsh-client-modules", "client.js"), "window.__ModuleLoader__.load({id:'@deepseek-ai/dsh-client-modules',factory:()=>({apply(){},createClientModuleSystem(){}})});");
    await writeFile(path.join(custom, "manifest.json"), JSON.stringify({
      version: 1, dshVersion: "0.1.6-alpha.2", registry: "https://registry.npmjs.org", generatedAt: "2026-01-01T00:00:00.000Z",
      frontend: { files: 1, rev: "x" },
      plugins: [{ id: "@deepseek-ai/dsh-client-modules", version: "0.1.6-alpha.2", rev: "111111111111", entry: "client.js", files: ["client.js"], inject: [], external: [], immediately: true }],
    }));
    const bare = await startServer({ vendor: custom, accessToken: undefined });
    const rendered = await bare.server.app.inject({ method: "GET", url: "/" }); expect([rendered.statusCode, rendered.body.includes("window.__ModuleLoader__={"), rendered.body.includes('globalThis["__DSH_BOOT__"]')]).toEqual([200, true, true]);
  });
  it("插件路由：rev 匹配才可读（content-type javascript），rev 不匹配/未知文件/未 vendor/路径穿越一律回绝", async () => {
    const { server } = await startServer();
    const manifest = JSON.parse(await readFile(path.join(VENDOR, "manifest.json"), "utf8")) as { plugins: Array<{ id: string; rev: string }> };
    const plugin = manifest.plugins[0]!;
    const good = await server.app.inject({ method: "GET", url: `/plugins/${plugin.id}/client.js?rev=${plugin.rev}` }); expect([good.statusCode, good.headers["content-type"]]).toEqual([200, expect.stringContaining("javascript")]); expect([
      (await server.app.inject({ method: "GET", url: `/plugins/${plugin.id}/client.js?rev=deadbeefdead` })).statusCode,
      (await server.app.inject({ method: "GET", url: `/plugins/${plugin.id}/nope.js` })).statusCode,
      (await server.app.inject({ method: "GET", url: "/plugins/not-vendored/client.js" })).statusCode,
      (await server.app.inject({ method: "GET", url: `/plugins/${plugin.id}/..%2f..%2fmanifest.json` })).statusCode,
    ]).toEqual([404, 404, 404, 404]);
  });
  it("WS remote.mux：$events 收到 ready、未知端点回 error；$events/result 把审批结果回路到 owc（allowed-once→allow）", async () => {
    const { base, deps } = await startServer();
    const { socket, frames } = await openSocket(base);
    socket.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "$events", payload: { args: {} } }));
    socket.send(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/nope", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    const ready = frames.find((frame) => frame.streamId === "s1")?.value as { type: string; clientId: string; host: { home: string } }; expect([ready.type, ready.host.home]).toEqual(["ready", "/home/tester"]);
    expect(frames.find((frame) => frame.streamId === "s2")).toMatchObject({ type: "error", error: { code: "gateway/method-unavailable" } });
    deps.events.publish({ source: "agent", type: "permission.request", sessionId: "s1", payload: { requestId: "perm-1", tool: "bash", input: { cmd: "ls" } } });
    await vi.waitFor(() => expect(frames.some((frame) => (frame.value as { type?: string })?.type === "waterfall")).toBe(true), { timeout: 3000 });
    const waterfall = frames.find((frame) => (frame.value as { type?: string })?.type === "waterfall")!.value as { eventId: string; event: string; agentId: string; request: Record<string, unknown> };
    expect([waterfall.event, waterfall.agentId, waterfall.request]).toEqual(["approval/request", "s1", expect.objectContaining({ toolName: "bash" })]);
    const response = await fetch(`${base}/api/$events/result`, {
      method: "POST", headers: { "content-type": "application/json", ...COOKIE },
      body: unaryBody("$events/result", { clientId: ready.clientId, eventId: waterfall.eventId, outcome: { kind: "result", value: "allowed-once" } }),
    });
    expect(JSON.parse(await response.text())).toMatchObject({ result: { ok: true } });
    // 批准必须真的落到 owc 权限链（allowed-once → allow），否则 UI 显示已批但工具仍被拦
    await vi.waitFor(() => expect(deps.respondPermission).toHaveBeenCalledWith("s1", "perm-1", "allow"));
    socket.close();
  });
  it("降级与桥接：vendor 缺失返回 undefined；手写 bridge 进图、bundle 可读、/dsh-owc/status 按凭据形态给回跳", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "owc-dsh-novendor-"));
    await mkdir(path.join(empty, "static"), { recursive: true }); expect(await buildDshServer({ vendorDirectory: empty, enabled: () => true, accessToken: () => undefined, deps: fakeDeps(), logger: { warn: () => {}, info: () => {} } } as never)).toBeUndefined();
    const { loadBridgePlugin, buildOwcStatus } = await import("../src/dsh/web-protocol/bridge.js");
    const assets = path.join(SERVER_ROOT, "assets");
    const bridge = await loadBridgePlugin(path.join(assets, "dsh-bridge")); expect([bridge?.id, bridge?.rev]).toEqual(["owc-dsh-bridge", expect.stringMatching(/^[0-9a-f]{12}$/)]);
    bridge!.originDirectory = path.join(assets, "dsh-bridge");
    const { server } = await startServer({
      bridgePlugin: bridge,
      owcStatus: (context: { cookieAuthenticated: boolean }) => buildOwcStatus({ version: "1.12.0", dshVersion: "0.1.6-alpha.2", mainPort: 3210, protocol: "http:", host: "127.0.0.1", accessToken: TOKEN, cookieAuthenticated: context.cookieAuthenticated }),
    });
    const index = await server.app.inject({ method: "GET", url: "/", headers: COOKIE }); expect(index.body).toContain("/plugins/owc-dsh-bridge/client.js?rev=");
    const bundle = await server.app.inject({ method: "GET", url: `/plugins/owc-dsh-bridge/client.js?rev=${bridge?.rev}` }); expect([bundle.statusCode, bundle.body.includes("__ModuleLoader__.load({")]).toEqual([200, true]); expect((await server.app.inject({ method: "GET", url: "/dsh-owc/status" })).statusCode).toBe(401);
    // cookie 已鉴权：回跳 URL 不带令牌（凭据不进 URL/历史）；Bearer 直探（无 cookie）才带令牌兜底
    const withCookie = await server.app.inject({ method: "GET", url: "/dsh-owc/status", headers: COOKIE }); expect(JSON.parse(withCookie.body)).toMatchObject({ version: "1.12.0", dshVersion: "0.1.6-alpha.2", workbenchUrl: "http://127.0.0.1:3210/" });
    expect(JSON.parse((await server.app.inject({ method: "GET", url: "/dsh-owc/status", headers: { authorization: `Bearer ${TOKEN}` } })).body))
      .toMatchObject({ workbenchUrl: `http://127.0.0.1:3210/?token=${TOKEN}` });
    expect(buildOwcStatus({ version: "1.12.0", dshVersion: "0.1.6-alpha.2", mainPort: 3210, protocol: "http:", host: "127.0.0.1" }).workbenchUrl).toBe("http://127.0.0.1:3210/");
  });
  it("门禁与令牌口径：TOTP 启用时无票据 401、有效票据放行；访问令牌请求期读取（轮换即生效/失效）", async () => {
    let token = TOKEN;
    const totp = { enabled: () => true, validateTicket: (ticket: string) => ticket === "valid-ticket" };
    const withTotp = await buildDshServer({
      vendorDirectory: VENDOR, enabled: () => true, accessToken: () => token, deps: fakeDeps(), totp, logger: { warn: () => {}, info: () => {} },
    } as never);
    servers.push(withTotp as DshServer); expect((await withTotp!.app.inject({ method: "GET", url: "/", headers: COOKIE })).statusCode).toBe(401); expect((await withTotp!.app.inject({ method: "GET", url: "/", headers: { cookie: `owc_access_token=${TOKEN}; owc_totp_session=valid-ticket` } })).statusCode).toBe(200);
    const rotated = await buildDshServer({
      vendorDirectory: VENDOR, enabled: () => true, accessToken: () => token, deps: fakeDeps(), logger: { warn: () => {}, info: () => {} },
    } as never);
    servers.push(rotated as DshServer); expect((await rotated!.app.inject({ method: "GET", url: "/", headers: COOKIE })).statusCode).toBe(200);
    token = "new-token-new-token-new-token-1111"; expect([
      (await rotated!.app.inject({ method: "GET", url: "/", headers: COOKIE })).statusCode,
      (await rotated!.app.inject({ method: "GET", url: "/", headers: { cookie: "owc_access_token=new-token-new-token-new-token-1111" } })).statusCode,
    ]).toEqual([401, 200]);
  });
});
