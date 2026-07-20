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
});
