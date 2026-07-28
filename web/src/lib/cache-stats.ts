import type { ContextTokenUsage } from "./contracts";

export interface CacheHitStats {
  /** 命中率：cacheRead / 总输入；无数据或总输入为 0 时为 null。 */
  rate: number | null;
  cacheRead: number;
  cacheWrite: number;
  /** 总输入 = 未缓存输入 + 缓存读取。 */
  totalInput: number;
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
  };
}
