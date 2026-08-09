import { describe, expect, it } from "vitest";
import { deriveWindowInfo, windowLevel } from "../lib/context-window";
import type { ContextBuildStats, ContextWatermark, ModelProfile } from "../lib/contracts";

const model: ModelProfile = {
  id: "test-model",
  provider: "test",
  contextWindow: 128_000,
  capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true },
};

const stats: ContextBuildStats = {
  totalTokens: 48_000,
  segments: { system: 1_000, compactionSummary: 2_000, toolResults: 20_000, messages: 24_000, repoMap: 1_000, other: 0 },
  pinnedTokens: 500,
  buildMs: 1.2,
  incremental: true,
};

const watermark: ContextWatermark = {
  estimatedTokens: 45_000,
  contextWindow: 128_000,
  workingBudget: 120_000,
  utilization: 0.375,
  segments: stats.segments,
  pinnedTokens: 500,
  buildMs: 0.8,
  incremental: true,
};

describe("deriveWindowInfo", () => {
  it("优先使用 WS 实时水位", () => {
    const info = deriveWindowInfo(watermark, stats, model);
    expect(info?.estimatedTokens).toBe(45_000);
    expect(info?.contextWindow).toBe(128_000);
    expect(info?.utilization).toBeCloseTo(0.375);
  });

  it("无水位时由 REST stats + 模型档案播种（workingBudget = 上下文窗口）", () => {
    const info = deriveWindowInfo(undefined, stats, model);
    expect(info?.estimatedTokens).toBe(48_000);
    expect(info?.contextWindow).toBe(128_000);
    expect(info?.workingBudget).toBe(128_000);
    expect(info?.utilization).toBeCloseTo(0.375);
    expect(info?.pinnedTokens).toBe(500);
  });

  it("模型窗口未知时仅返回 tokens，不给百分比", () => {
    const info = deriveWindowInfo(undefined, stats, undefined);
    expect(info?.estimatedTokens).toBe(48_000);
    expect(info?.contextWindow).toBeUndefined();
    expect(info?.utilization).toBeUndefined();
  });

  it("水位与 stats 都缺失时返回 undefined", () => {
    expect(deriveWindowInfo(undefined, undefined, model)).toBeUndefined();
  });
});

describe("windowLevel", () => {
  it("按 0.7 / 0.85 阈值分级", () => {
    expect(windowLevel(undefined)).toBe("normal");
    expect(windowLevel(0.35)).toBe("normal");
    expect(windowLevel(0.7)).toBe("warn");
    expect(windowLevel(0.84)).toBe("warn");
    expect(windowLevel(0.85)).toBe("danger");
    expect(windowLevel(1.1)).toBe("danger");
  });
});
