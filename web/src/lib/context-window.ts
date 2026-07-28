import type { ContextBuildStats, ContextSegmentBreakdown, ContextWatermark, ModelProfile } from "./contracts";

/**
 * 归一化的上下文窗口占用视图：优先取 WS 实时水位（context.watermark），
 * 否则由 REST stats（ContextBuildStats）+ 模型档案（contextWindow/maxOutput）播种，
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
  const workingBudget = contextWindow ? Math.max(1, contextWindow - (model?.maxOutput ?? 0)) : undefined;
  return {
    estimatedTokens: stats.totalTokens,
    ...(contextWindow ? { contextWindow } : {}),
    ...(workingBudget ? { workingBudget } : {}),
    ...(workingBudget ? { utilization: stats.totalTokens / workingBudget } : {}),
    segments: stats.segments,
    pinnedTokens: stats.pinnedTokens,
  };
}

export type WindowLevel = "normal" | "warn" | "danger";

/** 与服务端水位阈值一致：>=0.7 建议压缩（黄），>=0.85 强制压缩（红）。 */
export function windowLevel(utilization: number | undefined): WindowLevel {
  if (utilization === undefined) return "normal";
  if (utilization >= 0.85) return "danger";
  if (utilization >= 0.7) return "warn";
  return "normal";
}
