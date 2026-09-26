import { renderHook, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { createEventSocket } from "../app/ws";
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
/** wiring 与 event-socket 共用的确定性 WebSocket 桩。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  close(): void { /* no-op */ }
  serverOpen(): void { this.onopen?.(); }
  serverSend(event: Partial<AppEvent>): void { this.onmessage?.({ data: JSON.stringify({ type: "agent.state", ...event }) }); }
  serverClose(code?: number): void { this.onclose?.(code === undefined ? undefined : { code }); }
}
function makeWiring(overrides: Partial<Parameters<typeof createAppWiring>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stream = createStreamBuffer({ scheduleFrame: () => 0, cancelFrame: () => undefined });
  const wiring = createAppWiring({
    queryClient, getT: () => (chinese) => chinese, applyRunEvent: () => undefined, stream,
    getSessions: () => [{ id: "s1", title: "会话甲", cwd: "D:/w", provider: "p", model: "m", createdAt: "", updatedAt: "" }],
    socketEnv: { url: "ws://test/api/events", createSocket: (url) => new FakeSocket(url), bannerDelayMs: 0, baseDelayMs: 100 },
    ...overrides,
  });
  return { wiring, queryClient, stream, socket: FakeSocket.instances[0]! };
}
const joined = (stream: ReturnType<typeof createStreamBuffer>, id: string): string[] => stream.blocksFor(id).map((block) => block.parts.join(""));
describe("store 基础", () => {
  it("createStore 浅合并并通知订阅者、useStore 切片引用稳定、ui-store 通知与设置、session-store 键控条目", () => {
    const store = createStore({ a: 1, b: "x" }); const seen: number[] = [];
    store.subscribe(() => seen.push(store.get().a)); store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: "x" });
    store.set((previous) => ({ a: previous.a + 1 })); expect(seen).toEqual([2, 3]);
    const sliceStore = createStore({ a: 1, nested: { v: "keep" } });
    const { result, rerender } = renderHook(() => useStore(sliceStore, (state) => state.nested));
    const first = result.current;
    sliceStore.set({ a: 2 }); rerender(); expect(result.current).toBe(first);
    ui.notify("出错了", "error"); ui.openSettings("models");
    expect(uiStore.get().notice).toEqual({ kind: "error", text: "出错了" }); expect(uiStore.get().settingsTab?.tab).toBe("models");
    ui.closeSettings(); ui.clearNotifications(); ui.setNotice(undefined);
    // 权限卡 upsert（同 id 覆盖并前移）、removeSession 清键控条目、clearAgentStateIfIdle 只清 busy
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    sessionMeta.upsertPermission({ requestId: "r2", tool: "write_file", input: {} });
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: { cmd: "ls" } });
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r2", "r1"]);
    sessionMeta.clearPermissions(); expect(sessionStore.get().pendingPermissions).toEqual([]);
    sessionMeta.setRunFailure("s1", { message: "boom", retryable: true }); sessionMeta.removeSession("s1");
    expect(sessionStore.get().runFailures.s1).toBeUndefined();
    sessionMeta.setAgentState("s3", "idle"); sessionMeta.clearAgentStateIfIdle("s3");
    expect(sessionStore.get().agentStates.s3).toBe("idle");
  });
});
describe("app/wiring", () => {
  beforeEach(() => { FakeSocket.instances = []; ui.selectSession("s1"); });
  afterEach(() => { ui.selectSession(undefined); ui.setNotice(undefined); ui.clearNotifications(); });
  it("stream 通路：delta 进流式缓冲，idle 后失效会话查询且 flush；close() 提交残留积压，断线上报 reconnecting", () => {
    vi.useFakeTimers();
    try {
      const states: boolean[] = [];
      const { wiring, queryClient, socket, stream } = makeWiring({ onReconnecting: (value) => states.push(value) });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "streaming" } });
      socket.serverSend({ type: "message.delta", sessionId: "s1", payload: { text: "你好" } });
      stream.flush(); expect(joined(stream, "s1")).toEqual(["你好"]);
      socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "s1"] });
      socket.serverSend({ type: "message.delta", sessionId: "s1", payload: { text: "尾部token" } });
      expect(joined(stream, "s1")).toEqual(["你好"]);
      socket.serverClose(); vi.advanceTimersByTime(1); expect(states).toEqual([true]);
      wiring.close(); expect(joined(stream, "s1")).toEqual(["你好尾部token"]);
    } finally { vi.useRealTimers(); }
  });
  it("跨会话待办角标与通知通路：permission/interaction 增量维护、run 终态与 idle 清空；agent.error 写 toast、busy→idle 完成通知、桌面通知点击选中会话、forgetSession 后不再通知", () => {
    const notificationCtor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(notificationCtor, { permission: "granted" }));
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { wiring, socket } = makeWiring({ desktopNotifyEnabled: () => true });
    sessionStore.set({ attention: {} });
    socket.serverSend({ type: "permission.request", sessionId: "s2", payload: { requestId: "r1", tool: "bash", input: {} } });
    socket.serverSend({ type: "interaction.requested", sessionId: "s2", payload: { id: "q1", title: "选一个" } });
    socket.serverSend({ type: "permission.request", sessionId: "s2", payload: { requestId: "r2", tool: "bash", input: {} } });
    expect(sessionStore.get().attention.s2).toEqual({ permissions: 2, interactions: 1 });
    socket.serverSend({ type: "permission.resolved", sessionId: "s2", payload: { requestId: "r1" } });
    socket.serverSend({ type: "interaction.answered", sessionId: "s2", payload: { id: "q1" } });
    expect(sessionStore.get().attention.s2).toEqual({ permissions: 1, interactions: 0 });
    // 多余的解除事件不把计数压到负数；清零后条目整体移除
    socket.serverSend({ type: "permission.resolved", sessionId: "s2", payload: { requestId: "r1" } });
    socket.serverSend({ type: "permission.resolved", sessionId: "s2", payload: { requestId: "r2" } });
    expect(sessionStore.get().attention.s2).toBeUndefined();
    for (const event of [{ type: "run.completed", sessionId: "s2", payload: {} }, { type: "agent.state", sessionId: "s2", payload: { state: "idle" } }]) {
      sessionStore.set({ attention: { s2: { permissions: 1, interactions: 1 } } }); socket.serverSend(event);
      expect(sessionStore.get().attention.s2).toBeUndefined();
    }
    socket.serverSend({ type: "agent.error", sessionId: "s1", payload: { message: "boom" } });
    expect(uiStore.get().notice?.kind).toBe("error");
    const before = uiStore.get().notifications.length;
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "thinking" } });
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(uiStore.get().notifications).toHaveLength(before + 1);
    expect(uiStore.get().notifications.filter((item) => item.text.includes("会话甲"))).toHaveLength(1);
    wiring.router.forgetSession("s1");
    socket.serverSend({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } });
    expect(uiStore.get().notifications).toHaveLength(before + 1);
    socket.serverSend({ type: "run.completed", sessionId: "s1", payload: {} });
    const instance = notificationCtor.mock.instances.at(-1) as { onclick?: () => void };
    ui.selectSession(undefined); instance.onclick?.();
    expect(uiStore.get().sessionId).toBe("s1");
    wiring.close(); hiddenSpy.mockRestore(); vi.unstubAllGlobals();
  });
});
function setupEventSocket(options: { onEvent(event: AppEvent): void; onReconnecting?(reconnecting: boolean): void; onDisconnect?(): void }) {
  return createEventSocket(options, { url: "ws://test/api/events", createSocket: (url) => new FakeSocket(url), baseDelayMs: 100, maxDelayMs: 1_000 });
}
describe("createEventSocket", () => {
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it("连接 URL 携带 after=0 并按最新 seq 续传；eventId 去重、旧 sessionSeq 丢弃；断线退避/重连清除 reconnecting；1008 停止重连", () => {
    const onEvent = vi.fn(); const states: boolean[] = [];
    const socket = setupEventSocket({ onEvent, onReconnecting: (value) => states.push(value) });
    expect(FakeSocket.instances[0]?.url).toBe("ws://test/api/events?after=0");
    const first = FakeSocket.instances[0]!;
    first.serverOpen();
    first.serverSend({ eventId: "e1", seq: 41, sessionId: "s1", sessionSeq: 7 });
    first.serverSend({ eventId: "e1", seq: 42 });
    first.serverSend({ sessionId: "s1", sessionSeq: 6, seq: 43 });
    expect(onEvent.mock.calls.length).toBe(1);
    // 断开持续 1s 才上报横幅；间隔 100ms → 200ms；重连成功清除 reconnecting
    first.serverClose(); vi.advanceTimersByTime(500); expect(states).toEqual([]);
    vi.advanceTimersByTime(600); expect(states).toEqual([true]);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverClose(); vi.advanceTimersByTime(200);
    FakeSocket.instances[2]!.serverOpen(); expect(states).toEqual([true, false]);
    socket.close();
    onEvent.mockClear();
    FakeSocket.instances[2]!.serverSend({ seq: 1 }); FakeSocket.instances[2]!.serverClose();
    vi.advanceTimersByTime(10_000);
    expect(onEvent).not.toHaveBeenCalled(); expect(FakeSocket.instances).toHaveLength(3);
    // 1008（票据失效）停止重连
    FakeSocket.instances.length = 0;
    const expired = setupEventSocket({ onEvent: () => {} });
    FakeSocket.instances[0]!.serverClose(1008); vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1); expired.close();
  });
});
describe("App 外壳冒烟", () => {
  setupStubWebSocket();
  it("渲染工作台（消息 + Composer + 会话列表）", async () => {
    installAppFetchMock({
      session: makeSession({ id: "s1", title: "冒烟测试作业", messages: [{ id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建文件" }] }] }),
      models: [],
    });
    const view = renderWithClient(<App />);
    expect(await screen.findByText("请创建文件")).toBeInTheDocument();
    expect(document.getElementById("composer-input")).not.toBeNull();
    view.unmount();
  });
});
