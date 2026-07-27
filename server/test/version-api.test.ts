import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UpdateChecker } from "../src/update-checker.js";
import { setServerVersion } from "../src/version.js";

const roots: string[] = [];
afterEach(async () => {
  setServerVersion("0.0.0");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.5.2", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

function fakeCore(): CoreClientLike {
  const emitter = new EventEmitter();
  const client = {
    on(eventName: string, listener: (...args: unknown[]) => void) { emitter.on(eventName, listener); return client; },
    async start() { return FAKE_CORE_INFO; },
    async stop() { return; },
    async ping() { return FAKE_CORE_INFO; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;
  return client;
}

async function setup(updateChecker?: UpdateChecker) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-version-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "model-pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const core = fakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(updateChecker ? { updateChecker } : {}) });
  return { app, root };
}

describe("/api/version", () => {
  it("returns server, core, protocol and repo info", async () => {
    setServerVersion("0.5.2");
    const { app } = await setup();
    try {
      const response = await app.inject({ method: "GET", url: "/api/version" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ server: string; core: string; protocolVersion: string; githubRepo: string }>();
      expect(body.server).toBe("0.5.2");
      expect(body.core).toBe("0.5.2");
      expect(body.protocolVersion).toBe("1.0");
      expect(body.githubRepo).toBe("snnh/openwebcode");
    } finally {
      await app.close();
    }
  });
});

describe("/api/update-check", () => {
  it("returns 501 when no update checker is configured", async () => {
    const { app } = await setup();
    try {
      const response = await app.inject({ method: "GET", url: "/api/update-check" });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("returns the checker snapshot and refreshes on demand", async () => {
    setServerVersion("0.5.2");
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-version-uc-"));
    roots.push(root);
    const checker = new UpdateChecker({
      cachePath: path.join(root, "update-check.json"),
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: "v0.6.0", html_url: "https://github.com/snnh/openwebcode/releases/tag/v0.6.0", published_at: "2026-07-27T00:00:00Z" }), { status: 200 }),
    });
    checker.configure({ enabled: true, intervalHours: 24 });
    const { app } = await setup(checker);
    try {
      const refreshed = await app.inject({ method: "POST", url: "/api/update-check/refresh" });
      expect(refreshed.statusCode).toBe(200);
      const body = refreshed.json<{ snapshot: { latestVersion: string; isNewer: boolean } | null }>();
      expect(body.snapshot?.latestVersion).toBe("0.6.0");
      expect(body.snapshot?.isNewer).toBe(true);

      const got = await app.inject({ method: "GET", url: "/api/update-check" });
      expect(got.statusCode).toBe(200);
      expect(got.json<{ snapshot: { latestVersion: string } }>().snapshot?.latestVersion).toBe("0.6.0");
    } finally {
      checker.close();
      await app.close();
    }
  });
});
