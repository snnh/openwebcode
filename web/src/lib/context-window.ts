import type { ContextBuildStats, ContextSegmentBreakdown, ContextWatermark, ModelProfile, SettingsView } from "./contracts";

/**
 * 归一化的上下文窗口占用视图：优先取 WS 实时水位（context.watermark），
 * 否则由 REST stats（ContextBuildStats）+ 模型档案（contextWindow）播种，
 * 使重新加载后首个 watermark 事件到达前 meter 也可用。
 */
export interface ContextWindowInfo {
  estimatedTokens: number;
  contextWindow?: number;
  workingBudget?: number;
  utilization?: number;
  warning?: "force_compact" | "compact_recommended";
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
}

export function deriveWindowInfo(
  watermark: ContextWatermark | undefined,
  stats: ContextBuildStats | undefined,
  model: ModelProfile | undefined,
): ContextWindowInfo | undefined {
  if (watermark) {
    return {
      estimatedTokens: watermark.estimatedTokens,
      contextWindow: watermark.contextWindow,
      workingBudget: watermark.workingBudget,
      utilization: watermark.utilization,
      ...(watermark.warning ? { warning: watermark.warning } : {}),
      segments: watermark.segments,
      pinnedTokens: watermark.pinnedTokens,
    };
  }
  if (!stats) return undefined;
  const contextWindow = model?.contextWindow;
  const workingBudget = contextWindow;
  return {
    estimatedTokens: stats.totalTokens,
    ...(contextWindow ? { contextWindow } : {}),
    ...(workingBudget ? { workingBudget } : {}),
    ...(workingBudget ? { utilization: stats.totalTokens / workingBudget } : {}),
    segments: stats.segments,
    pinnedTokens: stats.pinnedTokens,
  };
}

type WindowLevel = "normal" | "warn" | "danger";

/** 从服务设置视图读取自动压缩水位（%）；未设置/越界回落默认 85。 */
export function compactionThresholdPercent(settings: SettingsView | undefined): number {
  const field = settings?.groups.flatMap((group) => group.fields).find((item) => item.key === "compactionThresholdPercent");
  return typeof field?.value === "number" && field.value >= 50 && field.value <= 95 ? field.value : 85;
}

/** 与服务端水位口径一致：>= threshold% 强制压缩（红），>= threshold−15% 建议压缩（黄）。 */
export function windowLevel(utilization: number | undefined, thresholdPercent = 85): WindowLevel {
  if (utilization === undefined) return "normal";
  const threshold = thresholdPercent / 100;
  if (utilization >= threshold) return "danger";
  if (utilization >= threshold - 0.15) return "warn";
  return "normal";
}
