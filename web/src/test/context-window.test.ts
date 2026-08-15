import { describe, expect, it } from "vitest";
import { compactionThresholdPercent, deriveWindowInfo, windowLevel } from "../lib/context-window";
import type { ContextBuildStats, ContextWatermark, ModelProfile, SettingsView } from "../lib/contracts";

const model: ModelProfile = {
  id: "test-model",
  provider: "test",
  contextWindow: 128_000,
  capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true },
};

const stats: ContextBuildStats = {
  totalTokens: 48_000,
  segments: { system: 2_000, input: 24_000, toolCalls: 20_000, output: 0, other: 2_000 },
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

  it("缺省阈值参数与旧硬编码 0.85/0.7 行为一致", () => {
    for (const utilization of [0.54, 0.7, 0.8499, 0.85, 1]) {
      expect(windowLevel(utilization)).toBe(windowLevel(utilization, 85));
    }
    expect(windowLevel(undefined, 70)).toBe("normal");
  });

  it("自定义阈值：danger = threshold/100，warn = (threshold−15)/100，精确边界", () => {
    // threshold = 70 → danger >= 0.70，warn >= 0.55
    expect(windowLevel(0.54, 70)).toBe("normal");
    expect(windowLevel(0.55, 70)).toBe("warn");
    expect(windowLevel(0.68, 70)).toBe("warn");
    expect(windowLevel(0.69, 70)).toBe("warn");
    expect(windowLevel(0.7, 70)).toBe("danger");
    expect(windowLevel(1, 70)).toBe("danger");
    // threshold = 50（下限）→ danger >= 0.50，warn >= 0.35
    expect(windowLevel(0.34, 50)).toBe("normal");
    expect(windowLevel(0.35, 50)).toBe("warn");
    expect(windowLevel(0.5, 50)).toBe("danger");
    // threshold = 95（上限）→ danger >= 0.95，warn >= 0.80
    expect(windowLevel(0.79, 95)).toBe("normal");
    expect(windowLevel(0.8, 95)).toBe("warn");
    expect(windowLevel(0.94, 95)).toBe("warn");
    expect(windowLevel(0.95, 95)).toBe("danger");
  });
});

describe("compactionThresholdPercent", () => {
  function settingsWith(value: unknown): SettingsView {
    return {
      groups: [{
        id: "context",
        label: "上下文与运行",
        fields: [
          { key: "compactionThresholdPercent", label: "自动压缩水位（%）", type: "number", value: value as number, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      }],
    };
  }

  it("读取合法字段值（50–95）", () => {
    expect(compactionThresholdPercent(settingsWith(50))).toBe(50);
    expect(compactionThresholdPercent(settingsWith(70))).toBe(70);
    expect(compactionThresholdPercent(settingsWith(95))).toBe(95);
  });

  it("设置缺失/字段缺失时回落 85", () => {
    expect(compactionThresholdPercent(undefined)).toBe(85);
    expect(compactionThresholdPercent({ groups: [] })).toBe(85);
    expect(compactionThresholdPercent(settingsWith(undefined))).toBe(85);
    expect(compactionThresholdPercent(settingsWith(null))).toBe(85);
  });

  it("越界/非数值回落 85", () => {
    expect(compactionThresholdPercent(settingsWith(49))).toBe(85);
    expect(compactionThresholdPercent(settingsWith(96))).toBe(85);
    expect(compactionThresholdPercent(settingsWith("70"))).toBe(85);
  });
});
