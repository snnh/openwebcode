import { describe, expect, it } from "vitest";
import { cacheHitRate, cacheTone, formatCacheTitle } from "../lib/cache-stats";

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

describe("writeShare / cacheTone / formatCacheTitle", () => {
  it("writeShare 为 cacheWrite / 总输入；无数据为 null", () => {
    expect(cacheHitRate({ inputTokens: 40_000, outputTokens: 0, cacheRead: 50_000, cacheWrite: 10_000 }).writeShare).toBeCloseTo(10_000 / 90_000);
    expect(cacheHitRate(undefined).writeShare).toBeNull();
  });

  it("cacheTone 三档边界：≥0.6 good、0.3–0.6 warn、<0.3 bad、null 归 good（调用方不渲染）", () => {
    const at = (rate: number | null) => cacheTone({ rate, cacheRead: 0, cacheWrite: 0, totalInput: 0, writeShare: null });
    expect(at(null)).toBe("good");
    expect(at(0.6)).toBe("good");
    expect(at(0.599)).toBe("warn");
    expect(at(0.3)).toBe("warn");
    expect(at(0.299)).toBe("bad");
    expect(at(0)).toBe("bad");
  });

  it("formatCacheTitle：口径 + 精确百分比 + 读写 + 低价提示", () => {
    const t = (zh: string, _en: string): string => zh;
    const short = (value: number): string => `${value}`;
    const stats = cacheHitRate({ inputTokens: 2_000, outputTokens: 0, cacheRead: 8_000, cacheWrite: 500 });
    const title = formatCacheTitle(stats, { cumulative: true }, t, short);
    expect(title).toContain("累计缓存命中 80.0%");
    expect(title).toContain("读取 8000");
    expect(title).toContain("写入 500");
    expect(title).toContain("低价计费");
    const lastCall = formatCacheTitle(stats, { cumulative: false }, t, short);
    expect(lastCall).toContain("本轮缓存命中");
    // 无缓存读取时不附加低价计费提示
    const cold = formatCacheTitle(cacheHitRate({ inputTokens: 100, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }), { cumulative: false }, t, short);
    expect(cold).not.toContain("低价计费");
  });
});
