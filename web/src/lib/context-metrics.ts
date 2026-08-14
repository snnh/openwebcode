import type { ContextBuildStats, ContextTokenUsage, ContextView } from "./contracts";

/**
 * 顶栏/底栏/状态栏共用的上下文指标切片（react-query select 用，模块级纯函数）：
 * 深比较下切片不变即保持引用——账本其余字段（entries/selection/压缩历史等）变化
 * 不再触发这些常驻组件的重渲。
 */
interface ContextMetricsSlice {
  usage: ContextTokenUsage;
  cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
  currency: "USD" | "CNY";
  tokenBudget: number | null;
}

export function selectContextMetrics(view: ContextView): ContextMetricsSlice {
  return {
    usage: view.ledger.usage,
    cost: view.ledger.cost,
    currency: view.preferences.currency,
    tokenBudget: view.ledger.policy?.maxSessionTokens ?? null,
  };
}

/** 底栏/状态栏切片：成本用量之外还要 stats（上下文窗口占用推导用）。 */
interface ContextStatusSlice extends ContextMetricsSlice {
  stats: ContextBuildStats | undefined;
}

export function selectContextStatusMetrics(view: ContextView): ContextStatusSlice {
  return { ...selectContextMetrics(view), stats: view.stats };
}

/** 会话成本摘要（顶栏/底栏/状态栏共用构造）：tokens 总计入 + 偏好币种成本标签。 */
export function buildCostSummary(
  slice: ContextMetricsSlice,
  formatCurrency: (microUnits: string, currency: "USD" | "CNY") => string,
): { tokens: number; costLabel: string; unpricedTokens: number } {
  return {
    tokens: slice.usage.inputTokens + slice.usage.outputTokens,
    costLabel: formatCurrency(slice.currency === "CNY" ? slice.cost.cnyMicroUnits : slice.cost.usdMicroUnits, slice.currency),
    unpricedTokens: slice.cost.unpricedTokens,
  };
}
