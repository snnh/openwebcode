import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const core = {
  on() { return core; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

describe("thinking persistence", () => {
  it("persists providers that emit thinking deltas without thinking_end", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-thinking-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-compatible", model: "reasoning-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "openai-compatible",
      async *streamChat() {
        yield { type: "thinking_delta", text: "先分析" };
        yield { type: "thinking_delta", text: "问题。" };
        yield { type: "text_delta", text: "最终答案" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "先分析问题。", provider: "openai-compatible" },
      { type: "text", text: "最终答案" },
    ]);
  });

  it("skips automatic checkpoints in manual snapshot mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-manual-snapshot-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test-model" });
    await sessions.updateConfig(session.id, { provider: "test", model: "test-model", snapshotMode: "manual" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register({
      name: "test",
      async *streamChat() {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "不要自动快照");

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("continues the user turn when an automatic checkpoint cannot be created", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-checkpoint-failure-"));
    roots.push(root);
    const missingWorkspace = path.join(root, "workspace-was-removed");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: missingWorkspace, provider: "test", model: "test-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register({
      name: "test",
      async *streamChat() {
        yield { type: "text_delta", text: "仍然继续" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const events = new EventBus();
    const observed: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "不要因为快照失败而丢失这条消息");

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.any(String) }) }),
    ]));
    expect(observed.some((event) => event.type === "agent.error")).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
