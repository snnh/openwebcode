import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionEventStream } from "../hooks/use-session-event-stream";
import type { AppEvent } from "../lib/contracts";

class StubWebSocket {
  static instances: StubWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly close = vi.fn();

  constructor(readonly url: string) {
    StubWebSocket.instances.push(this);
  }

  emit(event: AppEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}

function event(overrides: Partial<AppEvent> = {}): AppEvent {
  return {
    eventId: "event-1",
    source: "agent",
    type: "message.delta",
    sessionId: "s1",
    seq: 1,
    sessionSeq: 1,
    createdAt: "2026-07-22T00:00:00.000Z",
    payload: { text: "hello" },
    ...overrides,
  };
}

function Probe({ sessionId, onEvent }: { sessionId?: string; onEvent(event: AppEvent): void }) {
  const { reconnecting } = useSessionEventStream({ sessionId, onEvent });
  return <span data-testid="reconnecting">{String(reconnecting)}</span>;
}

describe("useSessionEventStream", () => {
  const original = globalThis.WebSocket;
  afterEach(() => {
    StubWebSocket.instances = [];
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("uses session cursors, de-duplicates replay, and disposes the old socket on a session switch", () => {
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    const view = render(<Probe sessionId="s1" onEvent={(value) => received.push(value)} />);
    const first = StubWebSocket.instances[0]!;
    expect(first.url).toContain("sessionId=s1");
    expect(first.url).toContain("after=0");

    act(() => first.emit(event()));
    act(() => first.emit(event()));
    expect(received).toHaveLength(1);

    view.rerender(<Probe sessionId="s2" onEvent={(value) => received.push(value)} />);
    expect(first.close).toHaveBeenCalledOnce();
    const second = StubWebSocket.instances[1]!;
    act(() => first.emit(event({ eventId: "old", sessionId: "s1", sessionSeq: 2 })));
    act(() => second.emit(event({ eventId: "new", sessionId: "s2", sessionSeq: 1 })));
    expect(received.map((item) => item.eventId)).toEqual(["event-1", "new"]);
  });

  it("断线退避重连期间暴露 reconnecting，重连成功后恢复", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    render(<Probe sessionId="s1" onEvent={() => undefined} />);
    const status = (): string | null => screen.getByTestId("reconnecting").textContent;
    expect(status()).toBe("false");

    const first = StubWebSocket.instances[0]!;
    act(() => first.onclose?.());
    // 横幅防抖：断开未满 1 秒不亮横幅
    expect(status()).toBe("false");
    act(() => vi.advanceTimersByTime(1_000));
    expect(status()).toBe("true");

    // 退避定时器（500ms 时已触发）建立的新 socket 握手成功后横幅消失
    const second = StubWebSocket.instances[1]!;
    expect(second).toBeDefined();
    act(() => second.onopen?.());
    expect(status()).toBe("false");
  });

  it("握手成功后退避重置：再次断线仍从短间隔开始重连", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    render(<Probe sessionId="s1" onEvent={() => undefined} />);

    const first = StubWebSocket.instances[0]!;
    act(() => first.onclose?.());
    act(() => vi.advanceTimersByTime(500));
    const second = StubWebSocket.instances[1]!;
    expect(second).toBeDefined();
    act(() => second.onopen?.());

    // 第二次断线：若 retry 未重置，本次间隔会是 1000ms，500ms 时不会有新 socket
    act(() => second.onclose?.());
    act(() => vi.advanceTimersByTime(500));
    expect(StubWebSocket.instances).toHaveLength(3);
  });

  it("1 秒内快速重连成功不亮重连横幅", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    render(<Probe sessionId="s1" onEvent={() => undefined} />);
    const status = (): string | null => screen.getByTestId("reconnecting").textContent;

    const first = StubWebSocket.instances[0]!;
    act(() => first.onclose?.());
    act(() => vi.advanceTimersByTime(500));
    const second = StubWebSocket.instances[1]!;
    act(() => second.onopen?.());
    act(() => vi.advanceTimersByTime(5_000));
    expect(status()).toBe("false");
  });
});
