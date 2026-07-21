import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-message-limit-"));
  roots.push(root);
  return root;
}

describe("POST /messages body limit", () => {
  it("routes an image envelope over the 1 MiB global limit to image validation", async () => {
    const root = await tempRoot();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "text-only", title: "Body limit" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });

    try {
      // A valid base64 alphabet payload slightly above Fastify's 1 MiB global
      // default. The text-only model causes a semantic 400 after parsing;
      // without the route-specific limit this would instead be a 413.
      const payload = JSON.stringify({
        content: "large image envelope",
        images: [{ mediaType: "image/png", data: "A".repeat(1024 * 1024 + 16 * 1024) }],
      });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);

      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("不支持图片");

      // The old alphabet-only predicate admitted impossible padding. Keep the
      // malformed payload on the normal-sized path so this asserts semantic
      // validation rather than a body-limit response.
      for (const data of ["A===", "AB=="]) {
        const malformed = await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/messages`,
          payload: { content: "malformed image", images: [{ mediaType: "image/png", data }] },
        });
        expect(malformed.statusCode, malformed.body).toBe(400);
        expect(malformed.json<{ error: string }>().error).toContain("images");
      }
    } finally {
      await app.close();
    }
  });
});
