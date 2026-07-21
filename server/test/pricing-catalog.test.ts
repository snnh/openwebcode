import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PricingCatalog, type PricingDocument } from "../src/cost/pricing-catalog.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    expect(catalog.get("openai", "claude-opus-4-8")).toBeUndefined();

    const replacement = document([entry("openai", "claude-opus-4-8", "2026-01-01")]);
    await catalog.replace(replacement);
    expect(catalog.get("openai", "claude-opus-4-8")?.input).toBe(2_000_000n);
    expect(catalog.get("anthropic", "claude-opus-4-8")).toBeUndefined();
  });

  it("falls back to built-in pricing when the persisted JSON is damaged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
    const file = path.join(root, "model-pricing.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "{broken", "utf8"));
    const catalog = new PricingCatalog(file);
    await catalog.initialize();
    expect(catalog.get("deepseek", "deepseek-chat")?.input).toBe(1_000_000n);
  });

  it("rejects normalized but nonexistent calendar dates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
    const catalog = new PricingCatalog(path.join(root, "model-pricing.json"));
    await catalog.initialize();
    await expect(catalog.replace(document([entry("anthropic", "x", "2026-02-30")]))).rejects.toThrow("valid YYYY-MM-DD");
  });

  it("rejects overlapping intervals without replacing the active catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
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
