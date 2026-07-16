import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("AgentRunner steering", () => {
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
    const queued = runner.enqueueSteering(session.id, "use the safer parser");
    expect(queued.position).toBe(1);
    expect(runner.listSteering(session.id)).toHaveLength(1);
    allowFirstToFinish();
    await running;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text === "use the safer parser"))).toBe(true);
    expect(runner.listSteering(session.id)).toEqual([]);
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
    const queued = runner.enqueueSteering(session.id, "remove me");
    expect(runner.removeSteering(session.id, queued.id)).toBe(true);
    finish();
    await running;
    expect((await sessions.get(session.id))?.messages.some((message) =>
      message.content.some((block) => block.type === "text" && block.text === "remove me"))).toBe(false);
  });
});
