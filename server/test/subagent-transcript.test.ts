import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("GET /api/sessions/:id/subagents/:taskId", () => {
  it("serves the persisted transcript and rejects invalid or missing taskIds", async () => {
    const root = await tempRoot("owc-subagent-rest-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = makeFakeCore();
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    try {
      const session = await sessions.create({ cwd: root, title: "Transcript route" });
      const taskId = "123e4567-e89b-42d3-a456-426614174000";
      await mkdir(path.join(sessions.contextRoot(session.id), "subagents"), { recursive: true });
      await writeFile(
        path.join(sessions.contextRoot(session.id), "subagents", `${taskId}.json`),
        JSON.stringify({ id: taskId, prompt: "调查", startedAt: new Date().toISOString(), turns: 1, toolsUsed: [], conclusion: "结论", messages: [] }),
        "utf8",
      );

      const ok = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/subagents/${taskId}` });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id: taskId, prompt: "调查", conclusion: "结论" });

      const missing = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/subagents/123e4567-e89b-42d3-a456-426614174001` });
      expect(missing.statusCode).toBe(404);

      const invalid = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/subagents/..%2F..%2Fledger` });
      expect([400, 404]).toContain(invalid.statusCode);
      const notUuid = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/subagents/not-a-uuid` });
      expect(notUuid.statusCode).toBe(400);

      const noSession = await app.inject({ method: "GET", url: `/api/sessions/123e4567-e89b-42d3-a456-426614174999/subagents/${taskId}` });
      expect(noSession.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
