/**
 * 常驻缓存上限（按运行模式缩放）。
 *
 * 这些上限是防 OOM 的安全网，不是性能开关：runtimeMode 只在安全区间内缩放
 * 可重建缓存的容量；pinned（活跃 run）缓存固定 768MB，不随模式变化。
 * 调用方在每次判断/清扫时读取 cacheLimits()，因此模式热切换立即生效。
 */
const MB = 1024 * 1024;

/** pinned 缓存的硬上限：活跃 run 优先，但超过它仍逐出最旧 pinned 条目。 */
export const PINNED_MESSAGES_TOTAL_BYTES = 768 * MB;

const BASE = {
  sessionPerEntryBytes: 48 * MB,
  sessionTotalBytes: 192 * MB,
  sessionEntries: 32,
  metaEntries: 64,
  chatPerEntryBytes: 48 * MB,
  chatTotalBytes: 192 * MB,
  chatEntries: 32,
  contextViews: 32,
  contextViewBytes: 128 * MB,
  contextLedgers: 32,
  contextLedgerBytes: 64 * MB,
  messageIndexes: 32,
};

export interface CacheLimits {
  sessionPerEntryBytes: number;
  sessionTotalBytes: number;
  sessionEntries: number;
  metaEntries: number;
  chatPerEntryBytes: number;
  chatTotalBytes: number;
  chatEntries: number;
  contextViews: number;
  contextViewBytes: number;
  contextLedgers: number;
  contextLedgerBytes: number;
  messageIndexes: number;
}

let scale = 1;

/** 模式倍率的安全边界：0.5x–2x；低于/高于此范围不生效。 */
export function setCacheScale(value: number): void {
  if (!Number.isFinite(value)) return;
  scale = Math.max(0.5, Math.min(2, value));
}

export function cacheScale(): number {
  return scale;
}

function scaled(value: number, minimum: number): number {
  return Math.max(minimum, Math.round(value * scale));
}

/** 当前生效的缓存上限；按调用时的模式倍率实时计算。 */
export function cacheLimits(): CacheLimits {
  return {
    sessionPerEntryBytes: scaled(BASE.sessionPerEntryBytes, 8 * MB),
    sessionTotalBytes: scaled(BASE.sessionTotalBytes, 32 * MB),
    sessionEntries: scaled(BASE.sessionEntries, 8),
    metaEntries: scaled(BASE.metaEntries, 16),
    chatPerEntryBytes: scaled(BASE.chatPerEntryBytes, 8 * MB),
    chatTotalBytes: scaled(BASE.chatTotalBytes, 32 * MB),
    chatEntries: scaled(BASE.chatEntries, 8),
    contextViews: scaled(BASE.contextViews, 8),
    contextViewBytes: scaled(BASE.contextViewBytes, 32 * MB),
    contextLedgers: scaled(BASE.contextLedgers, 8),
    contextLedgerBytes: scaled(BASE.contextLedgerBytes, 16 * MB),
    messageIndexes: scaled(BASE.messageIndexes, 4),
  };
}
