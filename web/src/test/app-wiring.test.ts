import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AppEvent } from "../lib/contracts";
import { createAppWiring } from "../app/wiring";
import { createStreamBuffer } from "../chat/stream-buffer";
import { ui, uiStore } from "../app/ui-store";

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
    applyActivityEvent: () => undefined,
    applySubagentEvent: () => undefined,
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
