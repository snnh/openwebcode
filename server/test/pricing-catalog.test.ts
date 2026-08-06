import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import type { ModelPricing } from "../src/context/model-profile.js";
import { CoreClient } from "../src/core-client.js";
import { calculateUsageCost } from "../src/cost/cost-calculator.js";
import { ExchangeRateService, RATE_SCALE, parseDecimalToScaled, type ExchangeRateProvider, type ExchangeRateSnapshot } from "../src/cost/exchange-rate.js";
import { PricingCatalog, type PricingDocument } from "../src/cost/pricing-catalog.js";
import type { Provider } from "../src/providers/provider.js";
import { tempRoot } from "./helpers/temp-roots.js";
import { makeTestApp } from "./helpers/test-app.js";

function document(entries: PricingDocument["entries"]): PricingDocument {
  return { version: 1, updatedAt: "2026-07-14T00:00:00.000Z", entries };
}

function entry(provider: string, model: string, from: string, until?: string): PricingDocument["entries"][number] {
  return {
    provider,
    model,
    currency: "USD",
    effectiveFrom: from,
    ...(until ? { effectiveUntil: until } : {}),
    input: "2000000",
    output: "10000000",
    cacheRead: "200000",
    cacheWrite: "2500000",
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("PricingCatalog", () => {
  it("seeds JSON and switches pricing by effective interval", async () => {
    const root = await tempRoot("owc-pricing-");
    const file = path.join(root, "model-pricing.json");
    const catalog = new PricingCatalog(file);
    await catalog.initialize();

    // 内置种子（deepseek）
    expect(catalog.get("deepseek", "deepseek-chat")?.input).toBe(1_000_000n);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);

    // 生效区间切换
    await catalog.replace(document([
      entry("deepseek", "deepseek-chat", "2026-01-01", "2026-09-01"),
      { ...entry("deepseek", "deepseek-chat", "2026-09-01"), input: "3000000" },
    ]));
    expect(catalog.get("deepseek", "deepseek-chat", new Date("2026-08-31T12:00:00Z"))?.input).toBe(2_000_000n);
    expect(catalog.get("deepseek", "deepseek-chat", new Date("2026-09-01T00:00:00Z"))?.input).toBe(3_000_000n);
  });

  it("isolates pricing by provider and hot-replaces future lookups", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    expect(catalog.get("openai", "claude-opus-4-8")).toBeUndefined();

    const replacement = document([entry("openai", "claude-opus-4-8", "2026-01-01")]);
    await catalog.replace(replacement);
    expect(catalog.get("openai", "claude-opus-4-8")?.input).toBe(2_000_000n);
    expect(catalog.get("anthropic", "claude-opus-4-8")).toBeUndefined();
  });

  it("falls back to built-in pricing when the persisted JSON is damaged", async () => {
    const root = await tempRoot("owc-pricing-");
    const file = path.join(root, "model-pricing.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "{broken", "utf8"));
    const catalog = new PricingCatalog(file);
    await catalog.initialize();
    expect(catalog.get("deepseek", "deepseek-chat")?.input).toBe(1_000_000n);
  });

  it("rejects normalized but nonexistent calendar dates", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    await expect(catalog.replace(document([entry("anthropic", "x", "2026-02-30")]))).rejects.toThrow("valid YYYY-MM-DD");
  });

  it("rejects overlapping intervals without replacing the active catalog", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    const before = catalog.list();

    await expect(catalog.replace(document([
      entry("anthropic", "x", "2026-01-01", "2026-10-01"),
      entry("anthropic", "x", "2026-09-01"),
    ]))).rejects.toThrow("overlap");
    expect(catalog.list()).toEqual(before);
  });

  it("syncs a valid remote pricing document atomically", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    const remote = {
      ...document([entry("openai", "gpt-future", "2026-01-01")]),
      updatedAt: "2026-07-21T12:00:00.000Z",
    };
    let signal: AbortSignal | undefined;

    const result = await catalog.syncFromUrl("https://pricing.example.test/catalog.json", {
      timeoutMs: 321,
      fetchImpl: (async (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Response(JSON.stringify(remote), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    expect(result).toEqual({ ok: true, count: 1, updatedAt: remote.updatedAt });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(catalog.list()).toEqual(remote);
    expect(catalog.get("openai", "gpt-future")?.input).toBe(2_000_000n);
  });

  it.each([
    ["invalid JSON", new Response("{not-json", { headers: { "content-type": "application/json" } }), undefined],
    ["unsupported version", new Response(JSON.stringify({ version: 2, updatedAt: "2026-07-21T12:00:00.000Z", entries: [] })), "version 1"],
    ["overlapping intervals", new Response(JSON.stringify(document([
      entry("anthropic", "x", "2026-01-01", "2026-10-01"),
      entry("anthropic", "x", "2026-09-01"),
    ]))), "overlap"],
  ])("does not replace the active catalog when remote data has %s", async (_name, response, message) => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    const before = catalog.list();

    const result = await catalog.syncFromUrl("https://pricing.example.test/catalog.json", {
      fetchImpl: (async () => response) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe("");
      if (message) expect(result.error).toContain(message);
    }
    expect(catalog.list()).toEqual(before);
  });

  it("does not replace the active catalog when the remote request fails", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    const before = catalog.list();

    const result = await catalog.syncFromUrl("https://pricing.example.test/catalog.json", {
      fetchImpl: (async () => { throw new Error("network unavailable"); }) as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "network unavailable" });
    expect(catalog.list()).toEqual(before);
  });

  it("serializes concurrent remote syncs so the later invocation wins", async () => {
    const root = await tempRoot("owc-pricing-");
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const older = {
      ...document([{ ...entry("openai", "gpt-future", "2026-01-01"), input: "1000000" }]),
      updatedAt: "2026-07-21T12:00:00.000Z",
    };
    const newer = {
      ...document([{ ...entry("openai", "gpt-future", "2026-01-01"), input: "9000000" }]),
      updatedAt: "2026-07-21T12:01:00.000Z",
    };
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return Response.json(older);
      }
      return Response.json(newer);
    }) as typeof fetch;

    const first = catalog.syncFromUrl("https://pricing.example.test/older.json", { fetchImpl });
    await firstStarted.promise;
    const second = catalog.syncFromUrl("https://pricing.example.test/newer.json", { fetchImpl });
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ ok: true, count: 1, updatedAt: older.updatedAt });
    await expect(second).resolves.toEqual({ ok: true, count: 1, updatedAt: newer.updatedAt });
    expect(calls).toBe(2);
    expect(catalog.list()).toEqual(newer);
    expect(catalog.get("openai", "gpt-future")?.input).toBe(9_000_000n);
  });
});

// ---- cost 组（合并） ----
const PRICING: ModelPricing = {
  currency: "USD",
  input: 5_000_000n,
  output: 25_000_000n,
  cacheRead: 500_000n,
  cacheWrite: 6_250_000n,
};

describe("cost accounting", () => {
  it("prices all four Anthropic token classes with fixed-point arithmetic", () => {
    const pricing = PRICING;
    const rate = {
      base: "USD" as const,
      quote: "CNY" as const,
      rate: 7_250_000n,
      source: "test",
      effectiveDate: "2026-07-14",
      fetchedAt: "2026-07-14T00:00:00.000Z",
    };
    const cost = calculateUsageCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    }, pricing, rate);

    expect(cost.source?.amount).toBe("36.75");
    expect(cost.usd?.amount).toBe("36.75");
    expect(cost.cny?.amount).toBe("266.4375");
  });

  it("retains native USD cost when exchange rates are unavailable", () => {
    const cost = calculateUsageCost(
      { inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
      PRICING,
      undefined,
    );
    expect(cost.priced).toBe(true);
    expect(cost.usd?.microUnits).toBe(5n);
    expect(cost.cny).toBeUndefined();
  });

  it("rejects over-precise exchange rates", () => {
    expect(parseDecimalToScaled("7.123456", RATE_SCALE)).toBe(7_123_456n);
    expect(() => parseDecimalToScaled("7.1234567", RATE_SCALE)).toThrow("fractional digits");
  });
});

// ---- exchange-rate 组（合并） ----
const fxRoots: string[] = [];
afterEach(async () => Promise.all(fxRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function remoteSnapshot(): ExchangeRateSnapshot {
  return {
    base: "USD",
    quote: "CNY",
    rate: 7_200_000n,
    source: "https://example.test/rates",
    effectiveDate: "2026-01-01",
    fetchedAt: new Date().toISOString(),
  };
}

function countingProvider(counter: { fetches: number }): ExchangeRateProvider {
  return {
    fetch: () => {
      counter.fetches += 1;
      return Promise.resolve(remoteSnapshot());
    },
  };
}

describe("ExchangeRateService 离线模式", () => {
  it("离线时跳过在线拉取（启动首拉与手动 refresh），回落固定汇率", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-fx-"));
    fxRoots.push(root);
    const counter = { fetches: 0 };
    const service = new ExchangeRateService({
      cachePath: path.join(root, "exchange-rate.json"),
      provider: countingProvider(counter),
      fixedUsdCnyRate: "7.10",
      isOffline: () => true,
    });
    await service.initialize();
    expect(counter.fetches).toBe(0);
    expect(service.current()?.source).toBe("configuration");
    await service.refresh();
    expect(counter.fetches).toBe(0);
    service.close();
  });

  it("离线且无缓存/固定汇率时保持无汇率，不发请求", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-fx-"));
    fxRoots.push(root);
    const counter = { fetches: 0 };
    const service = new ExchangeRateService({
      cachePath: path.join(root, "exchange-rate.json"),
      provider: countingProvider(counter),
      isOffline: () => true,
    });
    await service.initialize();
    expect(counter.fetches).toBe(0);
    expect(service.current()).toBeUndefined();
    service.close();
  });

  it("离线解除后恢复在线拉取（isOffline 现读热生效）", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-fx-"));
    fxRoots.push(root);
    const counter = { fetches: 0 };
    let offline = true;
    const service = new ExchangeRateService({
      cachePath: path.join(root, "exchange-rate.json"),
      provider: countingProvider(counter),
      isOffline: () => offline,
    });
    await service.initialize();
    expect(counter.fetches).toBe(0);
    offline = false;
    const snapshot = await service.refresh();
    expect(counter.fetches).toBe(1);
    expect(snapshot?.source).toBe("https://example.test/rates");
    service.close();
  });
});

// ---- app-pricing 组（合并） ----
function appPricing(input: string): PricingDocument {
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

async function appFixture(catalogFactory?: (file: string) => PricingCatalog) {
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
    const setup = await appFixture();
    try {
      await setup.catalog.replace(appPricing("2000000"));
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
        payload: appPricing("5000000"),
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
    const setup = await appFixture();
    try {
      await setup.catalog.replace(appPricing("2000000"));
      const invalid = appPricing("5000000");
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

    const setup = await appFixture((file) => new FailingCatalog(file));
    try {
      const response = await setup.app.inject({
        method: "PUT",
        url: "/api/model-pricing",
        payload: appPricing("5000000"),
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
