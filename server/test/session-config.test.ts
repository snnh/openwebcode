import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("session model config", () => {
  it("validates and persists idle model thinking and effort updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-session-config-")); roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
    const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
    const agent = { isRunning: () => false } as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events: new EventBus(), providers, pricing });
    try {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      // deepseek-chat 无 effort 能力 -> 设置 effort 被拒
      const invalid = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { effort: "high" } });
      expect(invalid.statusCode).toBe(400);
      // deepseek-reasoner 支持 thinking -> 切换模型并设置 thinking 通过
      const response = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "deepseek-reasoner", thinking: "enabled" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ model: "deepseek-reasoner", thinking: "enabled" });
      expect(await sessions.get(session.id)).toMatchObject({ model: "deepseek-reasoner", thinking: "enabled" });
      const invalidSnapshot = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { snapshotMode: "sometimes" } });
      expect(invalidSnapshot.statusCode).toBe(400);
      const modes = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off", snapshotMode: "manual" } });
      expect(modes.statusCode).toBe(200);
      expect(modes.json()).toMatchObject({ sandboxMode: "off", snapshotMode: "manual" });
      expect(await sessions.get(session.id)).toMatchObject({ sandboxMode: "off", snapshotMode: "manual" });
    } finally { await app.close(); }
  });
});
