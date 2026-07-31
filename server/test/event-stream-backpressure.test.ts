import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer, type ServerDependencies } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import {
  MAX_WS_BUFFERED_BYTES,
  MAX_WS_BUFFERED_MESSAGES,
  isSlowClient,
} from "../src/events/ws-backpressure.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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
