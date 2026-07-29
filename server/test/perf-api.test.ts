import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return {}; },
    async ping() { return { version: "test" }; },
  } as unknown as CoreClientLike;
  return core;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-perf-api-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = stubCore();
  const events = new EventBus();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  apps.push(app);
  return { app, session, agent, events };
}

describe("性能采样 REST 契约（0.5.0 Phase 2d）", () => {
  it("GET /api/sessions/:id/perf 无记录时返回空数组", async () => {
    const { app, session } = await setup();
    const response = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/perf` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ records: [] });
  });

  it("GET /api/sessions/:id/perf 不存在的会话返回 404", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/perf" });
    expect(response.statusCode).toBe(404);
  });
});
