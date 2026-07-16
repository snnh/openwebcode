import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events/event-bus.js";

describe("EventBus replay", () => {
  it("assigns sequence metadata and replays by session", () => {
    const bus = new EventBus(4);
    const first = bus.publish({ source: "session", type: "one", sessionId: "a", payload: null });
    const second = bus.publish({ source: "agent", type: "two", sessionId: "b", payload: null });
    bus.publish({ source: "agent", type: "three", sessionId: "a", payload: null });

    expect(first).toMatchObject({ seq: 1, type: "one" });
    expect(first.createdAt).toBeTruthy();
    expect(second.seq).toBe(2);
    expect(bus.replay(1, "a").events.map((event) => event.type)).toEqual(["three"]);
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
});
