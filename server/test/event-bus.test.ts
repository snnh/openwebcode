import { describe, expect, it } from "vitest";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";

describe("EventBus replay", () => {
  it("assigns sequence metadata and replays by session", () => {
    const bus = new EventBus(4);
    const first = bus.publish({ source: "session", type: "one", sessionId: "a", payload: null });
    const second = bus.publish({ source: "agent", type: "two", sessionId: "b", payload: null });
    bus.publish({ source: "agent", type: "three", sessionId: "a", payload: null });

    expect(first).toMatchObject({ seq: 1, sessionSeq: 1, type: "one" });
    expect(first.eventId).toMatch(/[0-9a-f-]{36}/);
    expect(first.createdAt).toBeTruthy();
    expect(second.seq).toBe(2);
    expect(bus.replay(1, "a").events.map((event) => event.type)).toEqual(["three"]);
    expect(bus.replay(1, "a").latestSeq).toBe(2);
  });

  it("requires REST resync when requested history was evicted", () => {
    const bus = new EventBus(2);
    bus.publish({ source: "server", type: "one", payload: null });
    bus.publish({ source: "server", type: "two", payload: null });
    bus.publish({ source: "server", type: "three", payload: null });
    bus.publish({ source: "server", type: "four", payload: null });

    expect(bus.replay(0).requiresResync).toBe(false);
    expect(bus.replay(1)).toMatchObject({ requiresResync: true, latestSeq: 4 });
  });

  it("enforces a total replay byte budget in addition to the event count", () => {
    const bus = new EventBus(100, 200);
    bus.publish({ source: "server", type: "small", payload: "a".repeat(40) });
    bus.publish({ source: "server", type: "large", payload: "b".repeat(400) });
    expect(bus.replay(1)).toMatchObject({ requiresResync: true, latestSeq: 2 });
    expect(bus.stats()).toMatchObject({ published: 2, retained: 1, oversizedNotRetained: 1 });
  });
});

describe("EventBus token delta 16ms 合批", () => {
  const delta = (sessionId: string, text: string) =>
    ({ source: "agent" as const, type: "message.delta", sessionId, payload: { text } });

  it("同 (sessionId, type) 键的 delta 在窗口内合并为一条事件", async () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 10);
    const seen: AppEvent[] = [];
    bus.on("event", (event: AppEvent) => seen.push(event));

    bus.publish(delta("s1", "你好"));
    bus.publish(delta("s1", "，世界"));
    bus.publish(delta("s1", "！"));
    // 窗口未到期：尚无事件定序发布
    expect(seen).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "message.delta", sessionId: "s1", sessionSeq: 1, payload: { text: "你好，世界！" } });
  });

  it("message.tool_call_delta 按 payload.id 分键：并行工具调用不串线", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 60_000);
    const call = (id: string, text: string) =>
      bus.publish({ source: "agent", type: "message.tool_call_delta", sessionId: "s1", payload: { id, text } });
    call("c1", "{\"a\"");
    call("c2", "{\"b\"");
    call("c1", ":1}");
    call("c2", ":2}");
    bus.flushDeltas();
    const seen = bus.replay(0).events.map((event) => [(event.payload as { id: string }).id, (event.payload as { text: string }).text]);
    expect(seen).toEqual([["c1", "{\"a\":1}"], ["c2", "{\"b\":2}"]]);
  });

  it("非 delta 事件不被合批延迟，且先把挂起 delta 冲刷以保住发布顺序", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 60_000);
    const seen: AppEvent[] = [];
    bus.on("event", (event: AppEvent) => seen.push(event));

    bus.publish(delta("s1", "abc"));
    const state = bus.publish({ source: "agent", type: "agent.state", sessionId: "s1", payload: { state: "responding" } });

    // 挂起的 delta 先于 state 事件定序，state 本身即时发布
    expect(seen.map((event) => event.type)).toEqual(["message.delta", "agent.state"]);
    expect(seen[0]).toMatchObject({ sessionSeq: 1, payload: { text: "abc" } });
    expect(state.sessionSeq).toBe(2);
    expect(seen[1].seq).toBe(seen[0]!.seq + 1);
  });

  it("不同 (sessionId, type) 键各自独立合批", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 60_000);
    bus.publish(delta("s1", "a"));
    bus.publish(delta("s2", "b"));
    bus.publish({ source: "agent", type: "message.thinking_delta", sessionId: "s1", payload: { text: "t" } });
    bus.flushDeltas();
    expect(bus.replay(0).events.map((event) => [event.sessionId, event.type, (event.payload as { text: string }).text]))
      .toEqual([["s1", "message.delta", "a"], ["s2", "message.delta", "b"], ["s1", "message.thinking_delta", "t"]]);
  });

  it("replay 前自动冲刷挂起 delta，sessionSeq 连续无洞", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 60_000);
    bus.publish(delta("s1", "x"));
    bus.publish(delta("s1", "y"));
    const replay = bus.replay(0, "s1");
    expect(replay.requiresResync).toBe(false);
    expect(replay.events.map((event) => event.sessionSeq)).toEqual([1]);
    expect((replay.events[0]!.payload as { text: string }).text).toBe("xy");
  });

  it("窗口为 0 时退化为逐条直发", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 0);
    const seen: AppEvent[] = [];
    bus.on("event", (event: AppEvent) => seen.push(event));
    bus.publish(delta("s1", "a"));
    bus.publish(delta("s1", "b"));
    expect(seen.map((event) => (event.payload as { text: string }).text)).toEqual(["a", "b"]);
  });

  it("payload 非 { text } 的同名事件不参与合批", () => {
    const bus = new EventBus(100, 4 * 1024 * 1024, 60_000);
    const seen: AppEvent[] = [];
    bus.on("event", (event: AppEvent) => seen.push(event));
    bus.publish({ source: "agent", type: "message.delta", sessionId: "s1", payload: { other: 1 } });
    expect(seen).toHaveLength(1);
  });
});
