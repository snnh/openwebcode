import { renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { createEventSocket, type EventSocket } from "../app/ws";
import { createStore, useStore } from "../app/store";
import { createAppWiring } from "../app/wiring";
import { createStreamBuffer } from "../chat/stream-buffer";
import { sessionMeta, sessionStore } from "../app/session-store";
import { ui, uiStore } from "../app/ui-store";
import type { AppEvent } from "../lib/contracts";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

describe("createStore", () => {
  it("get/set/subscribe：浅合并更新并通知订阅者", () => {
    const store = createStore({ a: 1, b: "x" });
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get().a));
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: "x" });
    store.set((previous) => ({ a: previous.a + 1 }));
    expect(store.get().a).toBe(3);
    expect(seen).toEqual([2, 3]);
    unsubscribe();
    store.set({ a: 9 });
    expect(seen).toHaveLength(2);
  });

  it("useStore：选择器订阅切片，未触碰字段引用稳定", () => {
    const store = createStore({ a: 1, nested: { v: "keep" } });
    const { result, rerender } = renderHook(() => useStore(store, (state) => state.nested));
    const first = result.current;
    store.set({ a: 2 });
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("ui-store", () => {
  it("notify 同时写 toast 与通知中心；openSettings 携带深链页签", () => {
    ui.notify("出错了", "error");
    const state = uiStore.get();
    expect(state.notice).toEqual({ kind: "error", text: "出错了" });
    expect(state.notifications.at(-1)?.text).toBe("出错了");
    ui.openSettings("models");
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsTab?.tab).toBe("models");
    ui.closeSettings();
    expect(uiStore.get().settingsOpen).toBe(false);
    // 清理，避免污染其他用例
    ui.clearNotifications();
    ui.setNotice(undefined);
  });
});

describe("session-store", () => {
  it("权限卡 upsert/remove/clear；removeSession 清理全部键控条目", () => {
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    sessionMeta.upsertPermission({ requestId: "r2", tool: "write_file", input: {} });
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: { cmd: "ls" } });
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r2", "r1"]);
    sessionMeta.removePermission("r2");
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r1"]);
    sessionMeta.clearPermissions();
    expect(sessionStore.get().pendingPermissions).toEqual([]);

    sessionMeta.setAgentState("s1", "thinking");
    sessionMeta.setRunFailure("s1", { message: "boom", retryable: true });
    sessionMeta.removeSession("s1");
    expect(sessionStore.get().agentStates.s1).toBeUndefined();
    expect(sessionStore.get().runFailures.s1).toBeUndefined();
  });

  it("clearAgentStateIfIdle 只清 busy 态", () => {
    sessionMeta.setAgentState("s1", "thinking");
    sessionMeta.setAgentState("s2", "idle");
    sessionMeta.clearAgentStateIfIdle("s1");
    sessionMeta.clearAgentStateIfIdle("s2");
    expect(sessionStore.get().agentStates.s1).toBeUndefined();
    expect(sessionStore.get().agentStates.s2).toBe("idle");
    sessionMeta.removeSession("s2");
  });
});

// ===== 以下 describe 合并自 app-wiring.test.ts =====

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  serverSend(event: Partial<AppEvent>): void {
    this.onmessage?.({ data: JSON.stringify({ type: "agent.state", ...event }) });
  }
}

function makeWiring(overrides: Partial<Parameters<typeof createAppWiring>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stream = createStreamBuffer({ scheduleFrame: () => 0, cancelFrame: () => undefined });
  const wiring = createAppWiring({
    queryClient,
    getT: () => (chinese) => chinese,
    getSessions: () => [{ id: "s1", title: "会话甲", cwd: "D:/w", provider: "p", model: "m", createdAt: "", updatedAt: "" }],
    applyRunEvent: () => undefined,
    socketEnv: { url: "ws://test/api/events", createSocket: (url) => new FakeSocket(url), bannerDelayMs: 0, baseDelayMs: 100 },
    stream,
    ...overrides,
  });
  return { wiring, queryClient, stream };
}

describe("app/wiring", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    ui.selectSession("s1");
  });
  afterEach(() => {
    ui.selectSession(undefined);
    ui.setNotice(undefined);
    ui.clearNotifications();
  });

  it("stream 通路：message.delta 进入流式缓冲，agent.state idle 后失效会话查询并清缓冲", () => {
    const { queryClient, stream } = makeWiring();
    const socket = FakeSocket.instances[0]!;
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "streaming" } });
    socket.serverSend({ type: "message.delta", sessionId: "s1", payload: { text: "你好" } });
    stream.flush();
    expect(stream.blocksFor("s1").map((block) => block.parts.join(""))).toEqual(["你好"]);
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "s1"] });
  });

  it("notify 通路：当前会话 agent.error 写入 toast 与通知中心", () => {
    makeWiring();
    const socket = FakeSocket.instances[0]!;
    socket.serverSend({ type: "agent.error", sessionId: "s1", payload: { message: "boom" } });
    expect(uiStore.get().notice?.kind).toBe("error");
    expect(uiStore.get().notifications.at(-1)?.text).toContain("boom");
  });

  it("busy→idle 完成通知只认状态迁移；forgetSession 后裸 idle 不再通知", () => {
    const { wiring } = makeWiring();
    const socket = FakeSocket.instances[0]!;
    const before = uiStore.get().notifications.length;
    // 裸 idle（无 busy 前置）不通知
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(uiStore.get().notifications.length).toBe(before);
    // busy → idle 迁移通知一次
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "thinking" } });
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(uiStore.get().notifications.length).toBe(before + 1);
    expect(uiStore.get().notifications.at(-1)?.text).toContain("会话甲");
    // forgetSession 清除完成检测残留：裸 idle 不通知
    wiring.router.forgetSession("s1");
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(uiStore.get().notifications.length).toBe(before + 1);
    wiring.close();
  });

  it("桌面通知包装：开关开启时转发 maybeDesktopNotify（点击选中会话）", () => {
    const notificationCtor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(notificationCtor, { permission: "granted" }));
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    makeWiring({ desktopNotifyEnabled: () => true });
    const socket = FakeSocket.instances[0]!;
    socket.serverSend({ type: "run.completed", sessionId: "s1", payload: {} });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    // 点击通知：聚焦 + 选中对应会话
    const instance = notificationCtor.mock.instances[0] as { onclick?: () => void };
    ui.selectSession(undefined);
    instance.onclick?.();
    expect(uiStore.get().sessionId).toBe("s1");
    hiddenSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("close() 触发 onDisconnect：未放出的流式积压全量提交", () => {
    const { wiring, stream } = makeWiring();
    const socket = FakeSocket.instances[0]!;
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "streaming" } });
    socket.serverSend({ type: "message.delta", sessionId: "s1", payload: { text: "尾部token" } });
    // 未 flush：积压仍在 pending，提交区为空
    expect(stream.blocksFor("s1")).toEqual([]);
    wiring.close();
    expect(stream.blocksFor("s1").map((block) => block.parts.join(""))).toEqual(["尾部token"]);
  });

  it("reconnecting 状态经 onReconnecting 透传", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const { wiring } = makeWiring({ onReconnecting: (value) => states.push(value) });
    const socket = FakeSocket.instances[0]!;
    socket.onclose?.();
    vi.advanceTimersByTime(1);
    expect(states).toEqual([true]);
    wiring.close();
    vi.useRealTimers();
  });
});

// ===== 以下 describe 合并自 app-ws.test.ts =====

class WsFakeSocket {
  static instances: WsFakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    WsFakeSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  // 测试驱动
  serverOpen(): void {
    this.onopen?.();
  }
  serverSend(event: Partial<AppEvent>): void {
    this.onmessage?.({ data: JSON.stringify({ type: "agent.state", ...event }) });
  }
  serverClose(code?: number): void {
    this.onclose?.(code === undefined ? undefined : { code });
  }
}

function setupEventSocket(options: { onEvent(event: AppEvent): void; onReconnecting?(reconnecting: boolean): void; onDisconnect?(): void }): EventSocket {
  return createEventSocket(options, {
    url: "ws://test/api/events",
    createSocket: (url) => new WsFakeSocket(url),
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  });
}

describe("createEventSocket", () => {
  beforeEach(() => {
    WsFakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连接 URL 携带 after=0；收到 seq 后重连按最新 seq 续传", () => {
    const onEvent = vi.fn();
    const socket = setupEventSocket({ onEvent });
    expect(WsFakeSocket.instances[0]?.url).toBe("ws://test/api/events?after=0");
    const first = WsFakeSocket.instances[0]!;
    first.serverOpen();
    first.serverSend({ seq: 41, sessionId: "s1", sessionSeq: 7 });
    expect(onEvent).toHaveBeenCalledTimes(1);
    // 断线 → 退避后重连，URL 带 after=41
    first.serverClose();
    vi.advanceTimersByTime(100);
    expect(WsFakeSocket.instances).toHaveLength(2);
    expect(WsFakeSocket.instances[1]?.url).toBe("ws://test/api/events?after=41");
    socket.close();
  });

  it("eventId 去重；同会话旧 sessionSeq 丢弃", () => {
    const onEvent = vi.fn();
    const socket = setupEventSocket({ onEvent });
    const first = WsFakeSocket.instances[0]!;
    first.serverSend({ eventId: "e1", seq: 1 });
    first.serverSend({ eventId: "e1", seq: 2 });
    expect(onEvent).toHaveBeenCalledTimes(1);
    first.serverSend({ sessionId: "s1", sessionSeq: 5, seq: 3 });
    first.serverSend({ sessionId: "s1", sessionSeq: 4, seq: 4 });
    expect(onEvent).toHaveBeenCalledTimes(2);
    socket.close();
  });

  it("断线退避重连：间隔指数增长封顶；断开持续 1s 才上报 reconnecting，握手成功清除", () => {
    const states: boolean[] = [];
    const socket = setupEventSocket({ onEvent: () => {}, onReconnecting: (value) => states.push(value) });
    const first = WsFakeSocket.instances[0]!;
    first.serverOpen();
    first.serverClose();
    // 横幅防抖：未到 1s 不上报
    vi.advanceTimersByTime(500);
    expect(states).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(states).toEqual([true]);
    // 已触发一次重连（100ms）；下一次间隔 200ms，再下一次 400ms
    expect(WsFakeSocket.instances).toHaveLength(2);
    WsFakeSocket.instances[1]!.serverClose();
    vi.advanceTimersByTime(200);
    expect(WsFakeSocket.instances).toHaveLength(3);
    WsFakeSocket.instances[2]!.serverClose();
    vi.advanceTimersByTime(400);
    expect(WsFakeSocket.instances).toHaveLength(4);
    // 握手成功：退避重置 + reconnecting 清除
    WsFakeSocket.instances[3]!.serverOpen();
    expect(states).toEqual([true, false]);
    WsFakeSocket.instances[3]!.serverClose();
    vi.advanceTimersByTime(100);
    expect(WsFakeSocket.instances).toHaveLength(5);
    socket.close();
  });

  it("close code 1008（票据失效）停止重连", () => {
    const socket = setupEventSocket({ onEvent: () => {} });
    WsFakeSocket.instances[0]!.serverClose(1008);
    vi.advanceTimersByTime(10_000);
    expect(WsFakeSocket.instances).toHaveLength(1);
    socket.close();
  });

  it("close() 后不再重连/派发，并回调 onDisconnect", () => {
    const onEvent = vi.fn();
    const onDisconnect = vi.fn();
    const socket = setupEventSocket({ onEvent, onDisconnect });
    const first = WsFakeSocket.instances[0]!;
    socket.close();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    first.serverSend({ seq: 1 });
    first.serverClose();
    vi.advanceTimersByTime(10_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(WsFakeSocket.instances).toHaveLength(1);
  });
});

// ===== 以下 describe 合并自 app-shell.test.tsx =====

/**
 * 新 App 外壳冒烟：装配层（wiring/queries/stores）+ 工作台 + 聊天区 + Composer 整体渲染。
 * 细的组件行为由各自组件测试覆盖，这里只验证「接起来能跑」。
 */

const session = makeSession({
  id: "s1",
  title: "冒烟测试作业",
  messages: [
    { id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建文件" }] },
    { id: "m2", role: "assistant", createdAt: "2026-07-17T00:00:01.000Z", content: [{ type: "text", text: "好的，已完成。" }] },
  ],
});

setupStubWebSocket();

describe("App 外壳冒烟", () => {
  it("渲染工作台：会话列表 + 消息 + Composer + 状态条", async () => {
    installAppFetchMock({ session, models: [] });
    renderWithClient(<App />);

    // 会话头与消息轨道
    expect(await screen.findByText("请创建文件")).toBeInTheDocument();
    expect(await screen.findByText("好的，已完成。")).toBeInTheDocument();
    // Composer（id 锚点）
    await waitFor(() => expect(document.getElementById("composer-input")).not.toBeNull());
    // 会话列表出现该会话（侧栏或移动抽屉，按视口而定——至少存在一处标题）
    expect(screen.getAllByText("冒烟测试作业").length).toBeGreaterThan(0);
  });

  it("详情加载中渲染骨架而非欢迎页", async () => {
    let resolveDetail: () => void = () => undefined;
    const detailReady = new Promise<void>((resolve) => { resolveDetail = resolve; });
    installAppFetchMock({ session, models: [] });
    const inner = globalThis.fetch;
    // 包一层挂起 detail 查询
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) await detailReady;
      return inner(input, init);
    });

    renderWithClient(<App />);
    expect(await screen.findByTestId("session-skeleton")).toBeInTheDocument();
    resolveDetail();
    expect(await screen.findByText("请创建文件")).toBeInTheDocument();
  });
});
