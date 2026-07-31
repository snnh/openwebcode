import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { RunStore } from "../src/agent/run-store.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("run snapshot API", () => {
  it("rebuilds live and terminal agent state from the durable run snapshot", async () => {
    const root = await tempRoot("owc-run-api-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
    await sessions.updateConfig(session.id, { provider: "fake", model: "fake-model", snapshotMode: "manual" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
    providers.register({
      name: "fake",
      async *streamChat() {
        providerStarted();
        await release;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
    const events = new EventBus();
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    apps.push(app);

    const running = agent.run(session.id, "work");
    await started;
    const live = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/run` });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ sessionId: session.id, state: "streaming", turnIndex: 0 });

    releaseProvider();
    await running;
    const terminal = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/run` });
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toMatchObject({ sessionId: session.id, state: "completed", turnIndex: 0 });
    expect(terminal.json().settledAt).toEqual(expect.any(String));
  });

  it("marks an interrupted persisted run as retryable instead of reporting it as running", async () => {
    const root = await tempRoot("owc-run-recovery-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
    const now = new Date().toISOString();
    await new RunStore(sessions.contextRoot(session.id)).write({
      id: "interrupted-run",
      sessionId: session.id,
      triggerMessageId: "message-1",
      state: "executing_tools",
      turnIndex: 2,
      startedAt: now,
      since: now,
    });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = { on() { return core; } } as unknown as CoreClientLike;
    const runner = new AgentRunner(sessions, new ProviderRegistry(), core, new EventBus(), pricing);

    await expect(runner.getRun(session.id)).resolves.toMatchObject({
      id: "interrupted-run",
      state: "failed",
      turnIndex: 2,
      error: { code: "server_restarted", retryable: true },
    });
  });
});
