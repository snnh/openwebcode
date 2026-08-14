import type { ContextTokenUsage } from "./contracts";

interface CacheHitStats {
  /** 命中率：cacheRead / 总输入；无数据或总输入为 0 时为 null。 */
  rate: number | null;
  cacheRead: number;
  cacheWrite: number;
  /** 总输入 = 未缓存输入 + 缓存读取。 */
  totalInput: number;
  /** 缓存写入占总输入的份额；无数据或总输入为 0 时为 null（供 title 明细，不直接出百分比）。 */
  writeShare: number | null;
}

/**
 * prompt cache 命中率（Anthropic 口径：inputTokens 是未缓存输入）。
 * usage 为 null/undefined 或总输入为 0 时 rate 为 null。
 */
export function cacheHitRate(usage: ContextTokenUsage | null | undefined): CacheHitStats {
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  const totalInput = (usage?.inputTokens ?? 0) + cacheRead;
  return {
    rate: totalInput > 0 ? cacheRead / totalInput : null,
    cacheRead,
    cacheWrite,
    totalInput,
    writeShare: totalInput > 0 ? cacheWrite / totalInput : null,
  };
}

/**
 * 命中率展示分档阈值（启发式体验档，与计费无关）：
 * ≥ good 不标注（默认色），warn–good 之间 amber，< warn danger。
 */
const CACHE_TONE_THRESHOLDS = { good: 0.6, warn: 0.3 } as const;

type CacheTone = "good" | "warn" | "bad";

/** rate 为 null 的调用方不渲染 pill，这里只处理有数情形。 */
export function cacheTone(stats: CacheHitStats): CacheTone {
  if (stats.rate === null || stats.rate >= CACHE_TONE_THRESHOLDS.good) return "good";
  return stats.rate >= CACHE_TONE_THRESHOLDS.warn ? "warn" : "bad";
}

/**
 * 缓存 pill 的统一悬浮明细（顶栏与上下文面板共用，消除重复拼接）：
 * 口径（本轮/累计）+ 精确命中率 + 读/写 tokens + 低价计费提示。
 */
export function formatCacheTitle(
  stats: CacheHitStats,
  opts: { cumulative: boolean },
  t: (zh: string, en: string) => string,
  formatTokensShort: (value: number) => string,
): string {
  const scope = opts.cumulative ? t("累计", "Session") : t("本轮", "Last call");
  const rateText = stats.rate !== null ? `${(stats.rate * 100).toFixed(1)}%` : "—";
  const base = t(
    `${scope}缓存命中 ${rateText}：读取 ${formatTokensShort(stats.cacheRead)} · 写入 ${formatTokensShort(stats.cacheWrite)}`,
    `${opts.cumulative ? "Session" : "Last-call"} cache hit ${rateText}: read ${formatTokensShort(stats.cacheRead)} · write ${formatTokensShort(stats.cacheWrite)}`,
  );
  return stats.cacheRead > 0
    ? `${base}${t("；缓存读取按低价计费", "; cached reads are billed at the lower cache rate")}`
    : base;
}
