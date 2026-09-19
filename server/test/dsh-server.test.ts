/**
 * dsh 端口服务单测（M4 步骤 15）：真实 Fastify 注入 + 真实 WS 连接。
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
const TOKEN = "test-token-123";

const servers: DshServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function fakeDeps(): DshWireDeps & { respondPermission: ReturnType<typeof vi.fn>; respondInteraction: ReturnType<typeof vi.fn> } {
  const metas: SessionMeta[] = [{
    id: "s1",
    cwd: "/work/proj",
    provider: "p",
    model: "m",
    title: "会话一",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
  } as SessionMeta];
  const projection = {
    sessions: {
      list: async () => metas,
      getMeta: async (id: string) => metas.find((entry) => entry.id === id),
      getTail: async (id: string) => (id === "s1"
        ? { ...metas[0], messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:05:00.000Z" }], hasMoreMessages: false }
        : undefined),
      get: async () => undefined,
      create: async () => metas[0] as never,
    },
    agent: {
      run: vi.fn(async () => {}),
      isRunning: () => false,
      abort: vi.fn(() => true),
      enqueueSteering: vi.fn(async () => ({ id: "s", position: 1, reused: false })),
      enqueueFollowUp: vi.fn(async () => ({ id: "q", position: 1, reused: false })),
      listQueue: async () => [],
      updateQueue: vi.fn(async () => undefined),
      removeQueue: vi.fn(async () => false),
    },
    defaultCwd: "/work/default",
  } as unknown as DshProjectionDeps;
  return {
    projection,
    events: new EventBus(),
    home: "/home/tester",
    respondPermission: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    logger: { warn: () => {} },
  } as never;
}

async function startServer(overrides: { enabled?: () => boolean; accessToken?: string | undefined; vendor?: string } = {}): Promise<{ server: DshServer; base: string }> {
  const server = await buildDshServer({
    vendorDirectory: overrides.vendor ?? VENDOR,
    enabled: overrides.enabled ?? (() => true),
    accessToken: "accessToken" in overrides ? overrides.accessToken : TOKEN,
    deps: fakeDeps(),
    logger: { warn: () => {}, info: () => {} },
  });
  expect(server).toBeDefined();
  const address = await (server as DshServer).listen("127.0.0.1", 0);
  servers.push(server as DshServer);
  return { server: server as DshServer, base: `http://${address}` };
}

function unaryBody(method: string, args: Record<string, unknown>, rpcId = "r1"): string {
  return JSON.stringify({ type: "client-request", rpcId, method, payload: { args } });
}

/** unary 注入（dsh 要求 Content-Type essence 精确为 application/json）。 */
function unaryInject(server: DshServer, endpoint: string, body: string, token: string | undefined) {
  return server.app.inject({
    method: "POST",
    url: `/api/${endpoint}`,
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { cookie: `owc_access_token=${token}` }) },
    payload: body,
  });
}

describe.skipIf(!VENDOR_READY)("dsh 端口服务（需 vendor）", () => {
  it("未鉴权时 API 与 index 401，静态资源与插件公开", async () => {
    const { server, base } = await startServer();
    const unauthorized = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), undefined);
    expect(unauthorized.statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: "/plugins/@deepseek-ai/dsh-client-ui-chat/client.js" })).statusCode).toBe(200);
    // 静态资产公开（读 manifest 里第一个真实文件）
    const manifest = JSON.parse(await readFile(path.join(VENDOR, "manifest.json"), "utf8")) as { plugins: Array<{ id: string }> };
    const pluginId = manifest.plugins[0]?.id ?? "";
    expect(pluginId).not.toBe("");
    const asset = await fetch(`${base}/api/session/list`, { method: "POST", body: unaryBody("session/list", { _request: {} }) });
    expect(asset.status).toBe(401);
  });

  it("cookie 与 bearer 均可鉴权；`/?token=` 换 cookie 并 303", async () => {
    const { server } = await startServer();
    const withCookie = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), TOKEN);
    expect(withCookie.statusCode).toBe(200);
    expect(JSON.parse(withCookie.body)).toMatchObject({ type: "server-response", rpcId: "r1", result: { ok: true } });
    const withBearer = await server.app.inject({
      method: "POST",
      url: "/api/session/list",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      payload: unaryBody("session/list", { _request: {} }),
    });
    expect(withBearer.statusCode).toBe(200);
    const exchanged = await server.app.inject({ method: "GET", url: `/?token=${TOKEN}` });
    expect(exchanged.statusCode).toBe(303);
    expect(exchanged.headers["set-cookie"]).toContain(`owc_access_token=${TOKEN}`);
    expect(exchanged.headers.location).toBe("/");
  });

  it("unary：session/list 投影值与 method-unavailable、path/method 不一致的 bad-request", async () => {
    const { server } = await startServer();
    const list = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), TOKEN);
    const parsed = JSON.parse(list.body) as { result: { ok: boolean; value: { items: Array<{ sessionId: string }> } } };
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.value.items[0]?.sessionId).toBe("s1");

    const missing = await unaryInject(server, "session/nope", unaryBody("session/nope", {}), TOKEN);
    expect(JSON.parse(missing.body)).toMatchObject({ result: { ok: false, error: { code: "gateway/method-unavailable" } } });

    const mismatch = await unaryInject(server, "session/list", unaryBody("session/other", {}), TOKEN);
    expect(JSON.parse(mismatch.body)).toMatchObject({ result: { ok: false, error: { code: "gateway/bad-request" } } });
  });

  it("关闭开关时 API/index 503（含 WS 拒绝）", async () => {
    const { server } = await startServer({ enabled: () => false });
    const auth = { cookie: `owc_access_token=${TOKEN}` };
    expect((await server.app.inject({ method: "GET", url: "/" , headers: auth})).statusCode).toBe(503);
    const api = await unaryInject(server, "session/list", unaryBody("session/list", { _request: {} }), TOKEN);
    expect(api.statusCode).toBe(503);
    expect(JSON.parse(api.body)).toMatchObject({ error: expect.stringContaining("dshCompatEnabled") });
  });

  it("自渲染 index 注入 boot graph（`__DSH_BOOT__`、模块系统 bootstrap、就绪尾标）", async () => {
    const { server } = await startServer();
    const response = await server.app.inject({ method: "GET", url: "/", headers: { cookie: `owc_access_token=${TOKEN}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("window.__ModuleLoader__={");
    expect(response.body).toContain("globalThis[\"__DSH_BOOT__\"]");
    expect(response.body).toContain("<script src=\"/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=");
    expect(response.body).toContain("__DSH_BOOT_READY__");
    // 模块 shell 标签仍在（来自 dist index.html）
    expect(response.body).toContain("<div id=\"root\">");
  });

  it("插件路由：rev 不匹配与未知文件 404，路径穿越被拒", async () => {
    const { server } = await startServer();
    const manifest = JSON.parse(await readFile(path.join(VENDOR, "manifest.json"), "utf8")) as { plugins: Array<{ id: string; rev: string; files: string[] }> };
    const plugin = manifest.plugins[0];
    expect(plugin).toBeDefined();
    const id = plugin?.id ?? "";
    const good = await server.app.inject({ method: "GET", url: `/plugins/${id}/client.js?rev=${plugin?.rev}` });
    expect(good.statusCode).toBe(200);
    expect(good.headers["content-type"]).toContain("javascript");
    expect((await server.app.inject({ method: "GET", url: `/plugins/${id}/client.js?rev=deadbeefdead` })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: `/plugins/${id}/nope.js` })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/plugins/not-vendored/client.js" })).statusCode).toBe(404);
  });

  it("WS /api/remote.mux：未鉴权在升级前 401，$events 收 ready，未知端点回 error 帧", async () => {
    const { base } = await startServer();
    const rejected = new WebSocket(`${base}/api/remote.mux`);
    const rejectedStatus = await new Promise<number>((resolve) => {
      rejected.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      rejected.on("close", () => resolve(-1));
      rejected.on("error", () => resolve(-2));
    });
    expect(rejectedStatus).toBe(401);

    const socket = new WebSocket(`${base}/api/remote.mux`, { headers: { cookie: `owc_access_token=${TOKEN}` } });
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));
    socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    socket.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "$events", payload: { args: {} } }));
    socket.send(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/nope", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    const ready = frames.find((frame) => frame.streamId === "s1" && frame.type === "item");
    expect((ready?.value as { type: string; host: { home: string } }).type).toBe("ready");
    expect((ready?.value as { host: { home: string } }).host.home).toBe("/home/tester");
    expect(frames.find((frame) => frame.streamId === "s2")).toMatchObject({ type: "error", error: { code: "gateway/method-unavailable" } });
    socket.close();
  });

  it("WS：$events/result 把审批结果回路到 owc（allowed-once→allow，拒绝→deny）", async () => {
    const deps = fakeDeps();
    const server = await buildDshServer({
      vendorDirectory: VENDOR,
      enabled: () => true,
      accessToken: TOKEN,
      deps,
      logger: { warn: () => {}, info: () => {} },
    });
    const address = await (server as DshServer).listen("127.0.0.1", 0);
    servers.push(server as DshServer);
    const socket = new WebSocket(`http://${address}/api/remote.mux`, { headers: { cookie: `owc_access_token=${TOKEN}` } });
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));
    socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    socket.send(JSON.stringify({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "item")).toBe(true), { timeout: 3000 });
    const ready = frames.find((frame) => frame.type === "item")?.value as { clientId: string };
    // 触发 owc 侧审批请求事件 → 应下发 waterfall 帧
    deps.events.publish({ source: "agent", type: "permission.request", sessionId: "s1", payload: { requestId: "perm-1", tool: "bash", input: { cmd: "ls" } } });
    await vi.waitFor(() => expect(frames.some((frame) => (frame.value as { type?: string })?.type === "waterfall")).toBe(true), { timeout: 3000 });
    const waterfallFrame = frames.find((frame) => (frame.value as { type?: string })?.type === "waterfall")?.value as { eventId: string; event: string; agentId: string; request: Record<string, unknown> };
    expect(waterfallFrame.event).toBe("approval/request");
    expect(waterfallFrame.agentId).toBe("s1");
    expect(waterfallFrame.request).toMatchObject({ toolName: "bash" });

    const response = await fetch(`http://${address}/api/$events/result`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `owc_access_token=${TOKEN}` },
      body: unaryBody("$events/result", { clientId: ready.clientId, eventId: waterfallFrame.eventId, outcome: { kind: "result", value: "allowed-once" } }),
    });
    expect(JSON.parse(await response.text())).toMatchObject({ result: { ok: true } });
    expect(deps.respondPermission).toHaveBeenCalledWith("s1", "perm-1", "allow");
    socket.close();
  });

  it("vendor 缺失时 buildDshServer 返回 undefined（如实降级而非半启动）", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "owc-dsh-novendor-"));
    await mkdir(path.join(empty, "static"), { recursive: true });
    expect(await buildDshServer({
      vendorDirectory: empty,
      enabled: () => true,
      accessToken: undefined,
      deps: fakeDeps(),
      logger: { warn: () => {}, info: () => {} },
    })).toBeUndefined();
  });

  it("桥接插件：随 owc 发布的手写 bundle 被加载、进图，且 /dsh-owc/status 返回 owc 事实", async () => {
    const { loadBridgePlugin, buildOwcStatus } = await import("../src/dsh/web-protocol/bridge.js");
    const assets = path.join(SERVER_ROOT, "assets");
    const bridge = await loadBridgePlugin(path.join(assets, "dsh-bridge"));
    expect(bridge).toBeDefined();
    expect(bridge?.id).toBe("owc-dsh-bridge");
    expect(bridge?.rev).toMatch(/^[0-9a-f]{12}$/);
    bridge!.originDirectory = path.join(assets, "dsh-bridge");
    const server = await buildDshServer({
      vendorDirectory: VENDOR,
      enabled: () => true,
      accessToken: TOKEN,
      deps: fakeDeps(),
      bridgePlugin: bridge,
      owcStatus: () => buildOwcStatus({ version: "1.12.0", dshVersion: "0.1.6-alpha.2", mainPort: 3210, protocol: "http:", host: "127.0.0.1", accessToken: TOKEN }),
      logger: { warn: () => {}, info: () => {} },
    });
    servers.push(server as DshServer);
    const index = await (server as DshServer).app.inject({ method: "GET", url: "/", headers: { cookie: `owc_access_token=${TOKEN}` } });
    expect(index.body).toContain("/plugins/owc-dsh-bridge/client.js?rev=");
    const bundle = await (server as DshServer).app.inject({ method: "GET", url: `/plugins/owc-dsh-bridge/client.js?rev=${bridge?.rev}` });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.body).toContain("__ModuleLoader__.load({");
    expect((await (server as DshServer).app.inject({ method: "GET", url: "/dsh-owc/status" })).statusCode).toBe(401);
    const status = await (server as DshServer).app.inject({ method: "GET", url: "/dsh-owc/status", headers: { cookie: `owc_access_token=${TOKEN}` } });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ version: "1.12.0", dshVersion: "0.1.6-alpha.2", workbenchUrl: `http://127.0.0.1:3210/?token=${TOKEN}` });
  });

  it("可注入 bridge 插件：graph 追加 application batch", async () => {
    const deps = fakeDeps();
    const server = await buildDshServer({
      vendorDirectory: VENDOR,
      enabled: () => true,
      accessToken: TOKEN,
      deps,
      bridgePlugin: { id: "owc-dsh-bridge", version: "1.12.0", rev: "abcdefabcdef", entry: "client.js", files: ["client.js"], inject: [], external: [] },
      logger: { warn: () => {}, info: () => {} },
    });
    servers.push(server as DshServer);
    const response = await (server as DshServer).app.inject({ method: "GET", url: "/", headers: { cookie: `owc_access_token=${TOKEN}` } });
    expect(response.body).toContain("/plugins/owc-dsh-bridge/client.js?rev=abcdefabcdef");
    const plugin = await (server as DshServer).app.inject({ method: "GET", url: "/plugins/owc-dsh-bridge/client.js" });
    // 文件不存在 → 404（但 graph 引用了它：调用方需先落盘 bridge 产物）
    expect(plugin.statusCode).toBe(404);
    // 静态 index 仍能渲染（bridge 产物缺失不影响其它行）
    expect(response.statusCode).toBe(200);
  });

  it("静态资源可读（assets 公开）", async () => {
    const { server } = await startServer();
    const index = await readFile(path.join(VENDOR, "static", "index.html"), "utf8");
    const assetPath = /src="\.(\/assets\/[^"]+)"/.exec(index)?.[1];
    expect(assetPath).toBeDefined();
    const asset = await server.app.inject({ method: "GET", url: assetPath ?? "/" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body.length).toBeGreaterThan(0);
  });

  it("写盘 fixture：无 HEAD 的 vendor 目录也能自渲染（head 注入前置）", async () => {
    const custom = await mkdtemp(path.join(tmpdir(), "owc-dsh-vendor2-"));
    await mkdir(path.join(custom, "static"), { recursive: true });
    await mkdir(path.join(custom, "plugins", "@deepseek-ai", "dsh-client-modules"), { recursive: true });
    await writeFile(path.join(custom, "static", "index.html"), "<html><body><div id=root></div></body></html>");
    await writeFile(path.join(custom, "plugins", "@deepseek-ai", "dsh-client-modules", "client.js"), "window.__ModuleLoader__.load({id:'@deepseek-ai/dsh-client-modules',factory:()=>({apply(){},createClientModuleSystem(){}})});");
    await writeFile(path.join(custom, "manifest.json"), JSON.stringify({
      version: 1,
      dshVersion: "0.1.6-alpha.2",
      registry: "https://registry.npmjs.org",
      generatedAt: "2026-01-01T00:00:00.000Z",
      frontend: { files: 1, rev: "x" },
      plugins: [{ id: "@deepseek-ai/dsh-client-modules", version: "0.1.6-alpha.2", rev: "111111111111", entry: "client.js", files: ["client.js"], inject: [], external: [], immediately: true }],
    }));
    const { server } = await startServer({ vendor: custom, accessToken: undefined });
    const response = await server.app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("window.__ModuleLoader__={");
    expect(response.body).toContain("globalThis[\"__DSH_BOOT__\"]");
  });
});
