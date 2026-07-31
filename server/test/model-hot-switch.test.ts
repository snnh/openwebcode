import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("AgentRunner model hot switching", () => {
  it("uses the updated model, thinking, and effort on the next run", async () => {
    const root = await tempRoot("owc-hot-model-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "claude-haiku-4-5" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "first");
    await sessions.updateConfig(session.id, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      thinking: "adaptive",
      effort: "xhigh",
    });
    await runner.run(session.id, "second");

    expect(requests[0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(requests[0]).not.toHaveProperty("thinking");
    expect(requests[1]).toMatchObject({ model: "claude-opus-4-8", thinking: "adaptive", effort: "xhigh" });
  });
});
