import { describe, expect, it } from "vitest";
import { cacheHitRate } from "../lib/cache-stats";

describe("cacheHitRate", () => {
  it("命中率为 cacheRead / (inputTokens + cacheRead)", () => {
    const stats = cacheHitRate({ inputTokens: 21_000, outputTokens: 500, cacheRead: 98_000, cacheWrite: 12_000 });
    expect(stats.rate).toBeCloseTo(98_000 / 119_000);
    expect(stats.cacheRead).toBe(98_000);
    expect(stats.cacheWrite).toBe(12_000);
    expect(stats.totalInput).toBe(119_000);
  });

  it("全部为零时 rate 为 null", () => {
    const stats = cacheHitRate({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    expect(stats.rate).toBeNull();
    expect(stats.totalInput).toBe(0);
  });

  it("usage 为 null/undefined 时 rate 为 null、计数为 0", () => {
    expect(cacheHitRate(undefined).rate).toBeNull();
    expect(cacheHitRate(null).rate).toBeNull();
    expect(cacheHitRate(undefined).cacheRead).toBe(0);
    expect(cacheHitRate(null).totalInput).toBe(0);
  });

  it("无缓存读取但有未缓存输入时命中率为 0", () => {
    const stats = cacheHitRate({ inputTokens: 5_000, outputTokens: 100, cacheRead: 0, cacheWrite: 0 });
    expect(stats.rate).toBe(0);
    expect(stats.totalInput).toBe(5_000);
  });

  it("纯缓存命中（inputTokens 为 0）时命中率为 1", () => {
    const stats = cacheHitRate({ inputTokens: 0, outputTokens: 0, cacheRead: 30_000, cacheWrite: 0 });
    expect(stats.rate).toBe(1);
  });
});
