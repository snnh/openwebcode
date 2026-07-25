import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer, type ServerDependencies } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import {
  DEFAULT_WS_BACKPRESSURE_LIMITS,
  MAX_WS_BUFFERED_BYTES,
  MAX_WS_BUFFERED_MESSAGES,
  isSlowClient,
} from "../src/events/ws-backpressure.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("慢客户端背压判定（单元）", () => {
  it("默认阈值：4MB 待发字节 / 1000 条待发消息", () => {
    expect(MAX_WS_BUFFERED_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_WS_BUFFERED_MESSAGES).toBe(1_000);
    expect(DEFAULT_WS_BACKPRESSURE_LIMITS).toEqual({ maxBufferedBytes: MAX_WS_BUFFERED_BYTES, maxBufferedMessages: MAX_WS_BUFFERED_MESSAGES });
  });

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
  it("慢客户端被补发 resync.required 后以 1013 断连，健康客户端照常收事件", async () => {
    const { WebSocket } = await import("ws");
    const stubCore = { on() { return stubCore; } } as unknown as CoreClient;
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-ws-bp-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, ".sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    // 字节上限压到 256KB，让测试不必真的打满 4MB 内核缓冲
    const deps: ServerDependencies = {
      core: stubCore,
      sessions,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      events,
      providers,
      pricing,
      wsBackpressureLimits: { maxBufferedBytes: 256 * 1024 },
    };
    const app = await buildServer(deps);
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = typeof address === "object" && address ? `ws://127.0.0.1:${address.port}` : "";

    // 慢客户端：握手成功后立即 pause 底层 socket，模拟永不读的消费端
    const slow = new WebSocket(`${base}/api/events`);
    const slowMessages: AppEvent[] = [];
    let slowCloseCode = 0;
    slow.on("message", (data: Buffer) => slowMessages.push(JSON.parse(data.toString()) as AppEvent));
    const slowClosed = new Promise<void>((resolve) => slow.on("close", (code: number) => { slowCloseCode = code; resolve(); }));
    await new Promise<void>((resolve) => slow.on("open", resolve));
    (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();

    // 健康客户端：正常读取
    const healthy = new WebSocket(`${base}/api/events`);
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

    // 灌入 ~2MB 事件流，慢客户端的内核/WS 缓冲被打满后触发背压断连。
    // 每次发布让出事件循环，给健康客户端留出走空窗口，避免它被误判为慢客户端。
    for (let i = 0; i < 10; i++) {
      events.publish({ source: "server", type: `flood-${i}`, payload: "x".repeat(200_000) });
      await new Promise((resolve) => setImmediate(resolve));
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
    await healthyGot(1);
    events.publish({ source: "server", type: "after-disconnect", payload: null });
    await new Promise<void>((resolve) => {
      const check = () => (healthyTypes.includes("after-disconnect") ? resolve() : setTimeout(check, 10));
      check();
    });
    healthy.close();
  }, 20_000);
});
