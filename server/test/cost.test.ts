import { describe, expect, it } from "vitest";
import { calculateUsageCost } from "../src/cost/cost-calculator.js";
import { RATE_SCALE, parseDecimalToScaled } from "../src/cost/exchange-rate.js";
import type { ModelPricing } from "../src/context/model-profile.js";

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
