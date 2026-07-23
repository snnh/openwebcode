import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("AgentRunner steering", () => {
  it("starts one durable follow-up after the current run reaches a natural stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-follow-up-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "steering",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          entered();
          await gate;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const initial = runner.run(session.id, "initial task");
    await firstEntered;
    const followUp = await runner.enqueueFollowUp(session.id, "continue with tests", "retry-safe-id");
    const duplicate = await runner.enqueueFollowUp(session.id, "continue with tests", "retry-safe-id");
    expect(duplicate).toMatchObject({ id: followUp.id, reused: true });
    release();
    await initial;
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(async () => expect((await sessions.get(session.id))?.messages.some((message) =>
      message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "continue with tests"))).toBe(true));
    await vi.waitFor(async () => {
      expect(runner.isRunning(session.id)).toBe(false);
      expect((await runner.getRun(session.id))?.state).toBe("completed");
    }, { timeout: 5_000 });
  });

  it("queues messages during a provider turn and applies them at the next safe boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-steering-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let allowFirstToFinish!: () => void;
    const gate = new Promise<void>((resolve) => { allowFirstToFinish = resolve; });
    const requests: StreamChatRequest[] = [];
    let turn = 0;
    const provider: Provider = {
      name: "steering",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          releaseFirst();
          await gate;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
    } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const queued = await runner.enqueueSteering(session.id, "use the safer parser");
    expect(queued.position).toBe(1);
    expect(await runner.listSteering(session.id)).toHaveLength(1);
    allowFirstToFinish();
    await running;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text === "use the safer parser"))).toBe(true);
    expect(await runner.listSteering(session.id)).toEqual([]);
    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining(["steering.queued", "steering.applied"]));
  });

  it("removes a queued message before it is applied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-steering-remove-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const provider: Provider = { name: "steering", async *streamChat() { entered(); await gate; yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const queued = await runner.enqueueSteering(session.id, "remove me");
    expect(await runner.removeSteering(session.id, queued.id)).toBe(true);
    finish();
    await running;
    expect((await sessions.get(session.id))?.messages.some((message) =>
      message.content.some((block) => block.type === "text" && block.text === "remove me"))).toBe(false);
  });

  it("preserves the unapplied steering queue when the run is aborted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-steering-abort-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const provider: Provider = {
      name: "steering",
      async *streamChat(request) {
        entered();
        // 模拟真实 provider 响应 abort：在信号触发前一直挂起
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted");
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    await runner.enqueueSteering(session.id, "saved for retry");
    expect(runner.abort(session.id)).toBe(true);
    await expect(running).rejects.toBeTruthy();
    // abort 保留未应用 steering，用户可在 idle 后重新入队/编辑
    expect((await runner.listSteering(session.id)).map((item) => item.content)).toEqual(["saved for retry"]);
  });

  it("rejects an over-long steering message with a too_long error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-steering-long-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const provider: Provider = { name: "steering", async *streamChat() { entered(); await gate; yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const oversized = "x".repeat(8_001);
    await expect(runner.enqueueSteering(session.id, oversized)).rejects.toThrow(/exceeds/);
    finish();
    await running;
  });
});
