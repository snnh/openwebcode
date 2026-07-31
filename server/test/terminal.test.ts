import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { TotpAuthService, base32Decode, totpAt } from "../src/auth-totp.js";
import type { CoreClient, PtyInputRequest, PtyOpenRequest, PtyResizeRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 造一个已启用 TOTP 的服务（setup→confirm 全程走真实校验） */
async function makeEnabledTotp(root: string): Promise<TotpAuthService> {
  const now = () => Date.now();
  const service = new TotpAuthService(path.join(root, "totp.json"), { now });
  await service.load();
  const { secret } = service.beginSetup();
  const recoveryCodes = await service.confirmSetup(totpAt(base32Decode(secret), now()));
  if (!recoveryCodes) throw new Error("confirmSetup failed in test setup");
  return service;
}

interface FakeCore {
  calls: { open: PtyOpenRequest[]; input: PtyInputRequest[]; resize: PtyResizeRequest[]; close: number[]; removed: number[] };
  emitters: Map<number, EventEmitter>;
  core: CoreClient;
}

/** 假 core：记录 pty 调用，ptyEvents 返回真实 EventEmitter 供测试注入 output/exit */
function makeFakeCore(): FakeCore {
  const calls: FakeCore["calls"] = { open: [], input: [], resize: [], close: [], removed: [] };
  const emitters = new Map<number, EventEmitter>();
  let nextPtyId = 1;
  const core = {
    openPty: async (request: PtyOpenRequest) => {
      calls.open.push(request);
      const ptyId = nextPtyId++;
      emitters.set(ptyId, new EventEmitter());
      return { ptyId, sandboxCapability: "none", sandboxReason: "sandbox disabled by terminal bridge" };
    },
    inputPty: async (request: PtyInputRequest) => {
      calls.input.push(request);
      return { ok: true };
    },
    resizePty: async (request: PtyResizeRequest) => {
      calls.resize.push(request);
      return { ok: true };
    },
    closePty: async (request: { ptyId: number }) => {
      calls.close.push(request.ptyId);
      return { ok: true };
    },
    ptyEvents: (ptyId: number) => {
      let emitter = emitters.get(ptyId);
      if (!emitter) {
        emitter = new EventEmitter();
        emitters.set(ptyId, emitter);
      }
      return emitter;
    },
    removePtyEvents: (ptyId: number) => {
      calls.removed.push(ptyId);
      emitters.delete(ptyId);
    },
  };
  return { calls, emitters, core: core as unknown as CoreClient };
}

async function buildTerminalApp(
  root: string,
  options: { totp?: TotpAuthService; accessToken?: string; listenHost?: string; core?: CoreClient } = {},
): Promise<{ app: FastifyInstance; sessions: SessionStore }> {
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const app = await buildServer({
    core: options.core ?? ({} as CoreClient),
    sessions,
    agent: { isRunning: () => false } as AgentRunner,
    events: new EventBus(),
    providers: new ProviderRegistry(),
    pricing,
    ...(options.totp ? { totp: options.totp } : {}),
    ...(options.listenHost !== undefined ? { listenHost: options.listenHost } : {}),
    ...(options.accessToken ? { auth: { accessToken: options.accessToken, allowedOrigins: ["https://owc.example.test"] } } : {}),
  });
  return { app, sessions };
}

async function listenPort(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return address.port;
}

/** 连接终端 WS：握手被拒时服务端在 upgrade 后立刻发 close 帧，open 后留 150ms 宽限再判定为已连接 */
function connectTerminal(url: string, headers: Record<string, string> = {}): Promise<{ socket: WebSocket; closeCode?: number; closeReason?: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      const timer = setTimeout(() => resolve({ socket }), 150);
      socket.once("close", () => clearTimeout(timer));
    });
    socket.once("close", (code, reason) => resolve({ socket, closeCode: code, closeReason: reason.toString() }));
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    socket.once("close", (code) => reject(new Error(`socket closed with ${code} while waiting for a frame`)));
  });
}

/** 连接终端 WS 并完成 open 握手（send open → expect opened），返回可用 socket */
async function openTerminal(
  port: number,
  sessionId: string,
  headers: Record<string, string>,
  size: { cols: number; rows: number } = { cols: 80, rows: 24 },
): Promise<WebSocket> {
  const { socket, closeCode } = await connectTerminal(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/terminal`, headers);
  expect(closeCode).toBeUndefined();
  const openedFrame = nextFrame(socket);
  socket.send(JSON.stringify({ type: "open", ...size }));
  expect(await openedFrame).toEqual({ type: "opened" });
  return socket;
}

describe("terminal WS 桥（/api/sessions/:id/terminal）", () => {
  it("TOTP 未开启时拒绝（1008 Terminal is unavailable）", async () => {
    const root = await tempRoot("owc-terminal-");
    const { app, sessions } = await buildTerminalApp(root, { core: makeFakeCore().core });
    try {
      const session = await sessions.create({ cwd: root });
      const port = await listenPort(app);
      const denied = await connectTerminal(`ws://127.0.0.1:${port}/api/sessions/${session.id}/terminal`);
      expect(denied.closeCode).toBe(1008);
      expect(denied.closeReason).toBe("Terminal is unavailable");
    } finally {
      await app.close();
    }
  });

  it("非回环/局域网监听地址拒绝（1008），即使凭据有效", async () => {
    const root = await tempRoot("owc-terminal-");
    const totp = await makeEnabledTotp(root);
    const { app, sessions } = await buildTerminalApp(root, { totp, listenHost: "0.0.0.0", core: makeFakeCore().core });
    try {
      const session = await sessions.create({ cwd: root });
      const port = await listenPort(app);
      const cookie = `owc_totp_session=${encodeURIComponent(totp.issueTicket())}`;
      const denied = await connectTerminal(`ws://127.0.0.1:${port}/api/sessions/${session.id}/terminal`, { cookie });
      expect(denied.closeCode).toBe(1008);
      expect(denied.closeReason).toBe("Terminal is unavailable");
    } finally {
      await app.close();
    }
  });

  it("TOTP 启用后无凭据拒绝（1008 Unauthorized）", async () => {
    const root = await tempRoot("owc-terminal-");
    const totp = await makeEnabledTotp(root);
    const { app, sessions } = await buildTerminalApp(root, { totp, core: makeFakeCore().core });
    try {
      const session = await sessions.create({ cwd: root });
      const port = await listenPort(app);
      const denied = await connectTerminal(`ws://127.0.0.1:${port}/api/sessions/${session.id}/terminal`);
      expect(denied.closeCode).toBe(1008);
      expect(denied.closeReason).toBe("Unauthorized origin or token");
    } finally {
      await app.close();
    }
  });

  it("bearer 通道（accessToken + 合法 Origin）同样可以开终端", async () => {
    const root = await tempRoot("owc-terminal-");
    const totp = await makeEnabledTotp(root);
    const accessToken = "a".repeat(32);
    const fake = makeFakeCore();
    const { app, sessions } = await buildTerminalApp(root, { totp, accessToken, core: fake.core });
    try {
      const session = await sessions.create({ cwd: root });
      const port = await listenPort(app);
      const headers = { authorization: `Bearer ${accessToken}`, origin: "https://owc.example.test" };
      const socket = await openTerminal(port, session.id, headers);
      expect(fake.calls.open).toHaveLength(1);
      socket.close();
    } finally {
      await app.close();
    }
  });

  describe("TOTP cookie 通道", () => {
    let root: string;
    let fake: FakeCore;
    let app: FastifyInstance;
    let session: { id: string; cwd: string };
    let port: number;
    let cookie: string;

    beforeEach(async () => {
      root = await tempRoot("owc-terminal-");
      const totp = await makeEnabledTotp(root);
      fake = makeFakeCore();
      let sessions: SessionStore;
      ({ app, sessions } = await buildTerminalApp(root, { totp, core: fake.core }));
      session = await sessions.create({ cwd: root });
      port = await listenPort(app);
      cookie = `owc_totp_session=${encodeURIComponent(totp.issueTicket())}`;
    });

    afterEach(async () => {
      await app.close();
    });

    it("open/in/resize/exit 全链路，sandbox 强制 false 且 cwd 取会话根", async () => {
      const socket = await openTerminal(port, session.id, { cookie });
      expect(fake.calls.open).toHaveLength(1);
      const openRequest = fake.calls.open[0]!;
      expect(openRequest.session).toBe(session.id);
      expect(openRequest.cwd).toBe(session.cwd);
      expect(openRequest.sandbox).toBe(false);
      expect(openRequest.cols).toBe(80);
      expect(openRequest.rows).toBe(24);
      expect(typeof openRequest.shell).toBe("string");
      const ptyId = 1;

      // core 推 output → out 帧
      const outFrame = nextFrame(socket);
      fake.emitters.get(ptyId)!.emit("output", { data: "aGk=" });
      expect(await outFrame).toEqual({ type: "out", data: "aGk=" });

      // in → inputPty 透传（形状预检之外不做 base64 校验）
      socket.send(JSON.stringify({ type: "in", data: "bHM=" }));
      await vi.waitFor(() => expect(fake.calls.input).toEqual([{ ptyId, data: "bHM=" }]));

      // resize → resizePty
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
      await vi.waitFor(() => expect(fake.calls.resize).toEqual([{ ptyId, cols: 120, rows: 40 }]));

      // 非法帧：尺寸越界 / 未知类型 → error 帧
      const badResize = nextFrame(socket);
      socket.send(JSON.stringify({ type: "resize", cols: 0, rows: 40 }));
      expect((await badResize).type).toBe("error");
      const unknown = nextFrame(socket);
      socket.send(JSON.stringify({ type: "bogus" }));
      expect((await unknown).type).toBe("error");

      // core 推 exit → exit 帧（带 code）且 pty 被回收
      const exitFrame = nextFrame(socket);
      fake.emitters.get(ptyId)!.emit("exit", { exitCode: 0 });
      expect(await exitFrame).toEqual({ type: "exit", code: 0 });
      await vi.waitFor(() => expect(fake.calls.close).toEqual([ptyId]));
      socket.close();
    });

    it("WS 断开即回收 pty（closePty + removePtyEvents）", async () => {
      const socket = await openTerminal(port, session.id, { cookie });
      socket.close();
      await vi.waitFor(() => {
        expect(fake.calls.close).toEqual([1]);
        expect(fake.calls.removed).toEqual([1]);
      });
    });

    it("两个并发终端各自独立：output 路由到各自 socket，互不影响", async () => {
      const first = await openTerminal(port, session.id, { cookie });
      const second = await openTerminal(port, session.id, { cookie }, { cols: 100, rows: 30 });
      expect(fake.calls.open).toHaveLength(2);

      // pty 2 的 output 只到达第二个 socket
      const secondOut = nextFrame(second);
      fake.emitters.get(2)!.emit("output", { data: "dHdv" });
      expect(await secondOut).toEqual({ type: "out", data: "dHdv" });
      const firstOut = nextFrame(first);
      fake.emitters.get(1)!.emit("output", { data: "b25l" });
      expect(await firstOut).toEqual({ type: "out", data: "b25l" });

      // 关掉第一个不影响第二个
      first.close();
      await vi.waitFor(() => expect(fake.calls.close).toEqual([1]));
      const secondOut2 = nextFrame(second);
      fake.emitters.get(2)!.emit("output", { data: "c3RpbGxhbGl2ZQ==" });
      expect(await secondOut2).toEqual({ type: "out", data: "c3RpbGxhbGl2ZQ==" });
      second.close();
    });
  });
});
