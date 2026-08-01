import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("WebUI static hosting", () => {
  it("serves the production index without shadowing API routes", async () => {
    const root = await tempRoot("owc-web-static-");
    const webDist = path.join(root, "web");
    await mkdir(webDist);
    await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>OpenWebCode</title>", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as AgentRunner,
      events,
      providers: new ProviderRegistry(),
      pricing,
      webDist,
    });
    try {
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("OpenWebCode");
      expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(page.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json()).toEqual({ status: "ok" });
      // API 响应不叠加 CSP（无渲染面）
      expect(health.headers["content-security-policy"]).toBeUndefined();
      expect((await app.inject({ method: "GET", url: "/api/metrics" })).json()).toMatchObject({ events: events.stats(), websocket: { clients: 0, slowClientDisconnects: 0, failedClientSends: 0 } });
    } finally {
      await app.close();
    }
  });
});
