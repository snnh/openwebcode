import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventSocket, type EventSocket } from "../app/ws";
import type { AppEvent } from "../lib/contracts";

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

function setup(options: { onEvent(event: AppEvent): void; onReconnecting?(reconnecting: boolean): void; onDisconnect?(): void }): EventSocket {
  return createEventSocket(options, {
    url: "ws://test/api/events",
    createSocket: (url) => new FakeSocket(url),
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  });
}

describe("createEventSocket", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连接 URL 携带 after=0；收到 seq 后重连按最新 seq 续传", () => {
    const onEvent = vi.fn();
    const socket = setup({ onEvent });
    expect(FakeSocket.instances[0]?.url).toBe("ws://test/api/events?after=0");
    const first = FakeSocket.instances[0]!;
    first.serverOpen();
    first.serverSend({ seq: 41, sessionId: "s1", sessionSeq: 7 });
    expect(onEvent).toHaveBeenCalledTimes(1);
    // 断线 → 退避后重连，URL 带 after=41
    first.serverClose();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]?.url).toBe("ws://test/api/events?after=41");
    socket.close();
  });

  it("eventId 去重；同会话旧 sessionSeq 丢弃", () => {
    const onEvent = vi.fn();
    const socket = setup({ onEvent });
    const first = FakeSocket.instances[0]!;
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
    const socket = setup({ onEvent: () => {}, onReconnecting: (value) => states.push(value) });
    const first = FakeSocket.instances[0]!;
    first.serverOpen();
    first.serverClose();
    // 横幅防抖：未到 1s 不上报
    vi.advanceTimersByTime(500);
    expect(states).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(states).toEqual([true]);
    // 已触发一次重连（100ms）；下一次间隔 200ms，再下一次 400ms
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverClose();
    vi.advanceTimersByTime(200);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.serverClose();
    vi.advanceTimersByTime(400);
    expect(FakeSocket.instances).toHaveLength(4);
    // 握手成功：退避重置 + reconnecting 清除
    FakeSocket.instances[3]!.serverOpen();
    expect(states).toEqual([true, false]);
    FakeSocket.instances[3]!.serverClose();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(5);
    socket.close();
  });

  it("close code 1008（票据失效）停止重连", () => {
    const socket = setup({ onEvent: () => {} });
    FakeSocket.instances[0]!.serverClose(1008);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.close();
  });

  it("close() 后不再重连/派发，并回调 onDisconnect", () => {
    const onEvent = vi.fn();
    const onDisconnect = vi.fn();
    const socket = setup({ onEvent, onDisconnect });
    const first = FakeSocket.instances[0]!;
    socket.close();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    first.serverSend({ seq: 1 });
    first.serverClose();
    vi.advanceTimersByTime(10_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
