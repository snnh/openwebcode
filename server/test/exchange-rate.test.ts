import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeRateService, type ExchangeRateProvider, type ExchangeRateSnapshot } from "../src/cost/exchange-rate.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
    roots.push(root);
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
    roots.push(root);
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
    roots.push(root);
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
