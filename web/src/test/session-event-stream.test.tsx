import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionEventStream } from "../hooks/use-session-event-stream";
import type { AppEvent } from "../lib/contracts";

class StubWebSocket {
  static instances: StubWebSocket[] = [];
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
  useSessionEventStream({ sessionId, onEvent });
  return null;
}

describe("useSessionEventStream", () => {
  const original = globalThis.WebSocket;
  afterEach(() => {
    StubWebSocket.instances = [];
    globalThis.WebSocket = original;
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
});
