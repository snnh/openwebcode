import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("remote listener security", () => {
  it("refuses a non-loopback listener without a strong token and explicit origins", () => {
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0" })).toThrow(/OWC_ACCESS_TOKEN/);
    expect(() => loadConfig({ OWC_HOST: "0.0.0.0", OWC_ACCESS_TOKEN: "a".repeat(32) })).toThrow(/OWC_ALLOWED_ORIGINS/);
    expect(loadConfig({
      OWC_HOST: "0.0.0.0",
      OWC_ACCESS_TOKEN: "a".repeat(32),
      OWC_ALLOWED_ORIGINS: "https://owc.example.test",
    })).toMatchObject({ host: "0.0.0.0", allowedOrigins: ["https://owc.example.test"] });
  });

  it("requires the configured token for every API route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-security-"));
    roots.push(root);
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
      auth: { accessToken: "t".repeat(32), allowedOrigins: ["https://owc.example.test"] },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { authorization: `Bearer ${"t".repeat(32)}` } })).json()).toEqual({ status: "ok" });
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-openwebcode-token": "wrong" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
