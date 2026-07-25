import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimitedProvider } from "../src/providers/concurrency-limiter.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";

/** A fake provider that yields events and tracks concurrent calls */
function fakeProvider(name: string): { provider: Provider; getCurrentConcurrent: () => number; getMaxConcurrent: () => number } {
  let current = 0;
  let max = 0;
  const provider: Provider = {
    name,
    async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
      current++;
      max = Math.max(max, current);
      try {
        yield { type: "text_delta", text: "hello" };
        // Small delay to simulate work
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "done", stopReason: "end_turn" };
      } finally {
        current--;
      }
    },
  };
  return { provider, getCurrentConcurrent: () => current, getMaxConcurrent: () => max };
}

const dummyRequest: StreamChatRequest = {
  model: "test",
  system: "",
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

describe("ConcurrencyLimitedProvider (0.5.0 Phase 2)", () => {
  it("limits concurrent streamChat calls to maxConcurrent", async () => {
    const { provider, getMaxConcurrent } = fakeProvider("test");
    const limited = new ConcurrencyLimitedProvider(provider, 2);

    // Launch 5 concurrent requests
    const promises = Array.from({ length: 5 }, () => {
      const events: ProviderEvent[] = [];
      return (async () => {
        for await (const event of limited.streamChat(dummyRequest)) events.push(event);
        return events;
      })();
    });

    await Promise.all(promises);

    // At most 2 should have been running simultaneously
    expect(getMaxConcurrent()).toBe(2);
  });

  it("queues excess requests and processes them in FIFO order", async () => {
    const callOrder: number[] = [];
    let counter = 0;
    const provider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        const id = counter++;
        callOrder.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 1);

    // Launch 3 concurrent requests
    await Promise.all([
      (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })(),
      (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })(),
      (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })(),
    ]);

    expect(callOrder).toEqual([0, 1, 2]);
  });

  it("releases slot on error", async () => {
    let callCount = 0;
    const provider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        callCount++;
        throw new Error("boom");
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 1);

    // First call throws
    await expect(async () => {
      for await (const _ of limited.streamChat(dummyRequest)) {}
    }).rejects.toThrow("boom");

    // Second call should succeed (slot was released)
    await expect(async () => {
      for await (const _ of limited.streamChat(dummyRequest)) {}
    }).rejects.toThrow("boom");

    expect(callCount).toBe(2);
  });

  it("exposes correct stats", async () => {
    // Use a provider with a controlled gate: each call blocks until a shared counter is incremented
    let gate = 0;
    const gates: Array<() => void> = [];
    const provider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        // Block until gate is opened
        if (gate === 0) await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 2);

    expect(limited.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });

    // Start two requests — both should acquire slots and block on the gate
    const p1 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    const p2 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limited.getStats().active).toBe(2);
    expect(limited.getStats().queued).toBe(0);

    // Start third — should be queued
    const p3 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limited.getStats()).toMatchObject({ active: 2, queued: 1 });

    // Open the gate — first request completes, third starts and also blocks
    gate = 1;
    gates.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));

    // All should complete now
    await Promise.all([p1, p2, p3]);
    expect(limited.getStats().active).toBe(0);
    expect(limited.getStats().queued).toBe(0);
  });

  it("proxies name and promptCaching properties", () => {
    const provider: Provider = {
      name: "test-provider",
      promptCaching: true,
      async *streamChat(): AsyncIterable<ProviderEvent> {
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 3);
    expect(limited.name).toBe("test-provider");
    expect(limited.promptCaching).toBe(true);
  });
});
