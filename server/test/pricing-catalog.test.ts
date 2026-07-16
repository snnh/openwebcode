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

describe("PricingCatalog", () => {
  it("seeds JSON and switches Sonnet pricing by effective interval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pricing-"));
    roots.push(root);
    const file = path.join(root, "model-pricing.json");
    const catalog = new PricingCatalog(file);
    await catalog.initialize();

    expect(catalog.get("anthropic", "claude-sonnet-5", new Date("2026-08-31T12:00:00Z"))?.input).toBe(2_000_000n);
    expect(catalog.get("anthropic", "claude-sonnet-5", new Date("2026-09-01T00:00:00Z"))?.input).toBe(3_000_000n);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
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
    expect(catalog.get("anthropic", "claude-opus-4-8")?.input).toBe(5_000_000n);
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
});
