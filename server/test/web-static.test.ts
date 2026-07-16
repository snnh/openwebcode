import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("WebUI static hosting", () => {
  it("serves the production index without shadowing API routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-web-static-"));
    roots.push(root);
    const webDist = path.join(root, "web");
    await mkdir(webDist);
    await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>OpenWebCode</title>", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events: new EventBus(),
      providers: new ProviderRegistry(),
      pricing,
      webDist,
    });
    try {
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("OpenWebCode");
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
