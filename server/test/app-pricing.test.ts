import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoreClient } from "../src/core-client.js";
import { ContextManager } from "../src/context/context-manager.js";
import { PricingCatalog, type PricingDocument } from "../src/cost/pricing-catalog.js";
import type { Provider } from "../src/providers/provider.js";
import { makeTestApp } from "./helpers/test-app.js";

function pricing(input: string): PricingDocument {
  return {
    version: 1,
    updatedAt: "2026-07-14T00:00:00.000Z",
    entries: [{
      provider: "test",
      model: "claude-opus-4-8",
      currency: "USD",
      effectiveFrom: "2020-01-01",
      input,
      output: "0",
      cacheRead: "0",
      cacheWrite: "0",
    }],
  };
}

const testProvider: Provider = {
  name: "test",
  async *streamChat() {
    yield { type: "usage", inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    yield { type: "done", stopReason: "end_turn" };
  },
};

async function fixture(catalogFactory?: (file: string) => PricingCatalog) {
  const setup = await makeTestApp({
    tempPrefix: "owc-app-pricing-",
    pricing: (root) => catalogFactory?.(path.join(root, "model-pricing.json"))
      ?? new PricingCatalog(path.join(root, "model-pricing.json")),
    agent: "real",
    core: (root) => {
      const core = new CoreClient(path.join(root, "unused-core"));
      core.configureSession = async () => ({ sandboxCapability: "advisory" });
      return core;
    },
    configureProviders: (providers) => providers.register(testProvider),
  });
  return { root: setup.root, sessions: setup.sessions, catalog: setup.pricing, events: setup.observed, agent: setup.agent, app: setup.app };
}

describe("model pricing API", () => {
  it("applies a hot update only to subsequent usage", async () => {
    const setup = await fixture();
    try {
      await setup.catalog.replace(pricing("2000000"));
      const session = await setup.sessions.create({
        cwd: setup.root,
        provider: "test",
        model: "claude-opus-4-8",
      });
      const manager = new ContextManager(setup.sessions.contextRoot(session.id));

      await setup.agent.run(session.id, "first");
      expect((await manager.load()).cost.usdMicroUnits).toBe("2");

      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/model-pricing",
        payload: pricing("5000000"),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<PricingDocument>().entries[0]?.input).toBe("5000000");
      expect((await manager.load()).cost.usdMicroUnits).toBe("2");

      await setup.agent.run(session.id, "second");
      const ledger = await manager.load();
      expect(ledger.cost.usdMicroUnits).toBe("7");

      const updates = setup.events.filter((event) => event.type === "model.pricing_updated");
      expect(updates).toHaveLength(1);
      const usage = setup.events.filter((event) => event.type === "context.usage");
      expect(usage).toHaveLength(2);
      expect(usage[1]?.payload).toMatchObject({
        cost: { priced: true, source: { currency: "USD", amount: "0.000005" }, usd: "0.000005" },
        sessionCost: { usdMicroUnits: "7" },
      });
    } finally {
      await setup.app.close();
    }
  });

  it("returns 400 for invalid pricing without changing the active catalog", async () => {
    const setup = await fixture();
    try {
      await setup.catalog.replace(pricing("2000000"));
      const invalid = pricing("5000000");
      invalid.entries[0]!.effectiveFrom = "2026-02-30";
      const response = await setup.app.inject({ method: "PUT", url: "/api/model-pricing", payload: invalid });

      expect(response.statusCode).toBe(400);
      expect(setup.catalog.get("test", "claude-opus-4-8")?.input).toBe(2_000_000n);
      expect(setup.events.filter((event) => event.type === "model.pricing_updated")).toHaveLength(0);
    } finally {
      await setup.app.close();
    }
  });

  it("returns a sanitized 500 when pricing persistence fails", async () => {
    class FailingCatalog extends PricingCatalog {
      override async replace(_value: unknown): Promise<PricingDocument> {
        throw new Error("EACCES: D:/secret/model-pricing.json");
      }
    }

    const setup = await fixture((file) => new FailingCatalog(file));
    try {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/model-pricing",
        payload: pricing("5000000"),
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Failed to persist model pricing" });
      expect(response.body).not.toContain("secret");
      expect(setup.events.filter((event) => event.type === "model.pricing_updated")).toHaveLength(0);
    } finally {
      await setup.app.close();
    }
  });
});
