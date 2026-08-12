import type { ContextView } from "./contracts";

/**
 * 上下文压缩检查点（/compact 与 85% 水位强制压缩）的消息流投影：
 * - 实时标记由 WS 事件（context.compacting/compacted/compact_failed）驱动，经 live-store 进入消息流尾部；
 * - 历史还原从 ContextView 的账本记录（compactionHistory，缺省回退 compacted 单条）推导；
 * 全部为纯客户端投影——模型-facing 的压缩框架消息不进聊天流，账本/消息文件不因此改变。
 */

export type CompactionMode = "toolcalls" | "overview" | "truncated" | "vault";

export interface CompactionMarker {
  /** 稳定 id（`compaction:<createdAt>`；运行中占位为 `compaction:live`）：原位沉降复用同一 React key。 */
  id: string;
  /** 活动路径下标：messages[0..uptoIndex) 被该次压缩取代；运行中占位为 -1（落尾部）。 */
  uptoIndex: number;
  mode: CompactionMode;
  /** 85% 水位强制（否则为手动 /compact 或面板按钮）。 */
  forced: boolean;
  createdAt: string;
  status: "running" | "settled" | "failed";
  /** 被替换消息段的 token 估算（账本写入时烧入；旧记录缺省则不显示）。 */
  replacedTokens?: number;
  /** 失败原因（status=failed 时存在）。 */
  error?: string;
  /** 摘要与指令（仅历史还原的记录带有；有值即可展开）。 */
  summary?: string;
  instructions?: string[];
}

/** 模式标签双语对（event-router toast、Context 面板、检查点行共用同一来源）：t(...compactionModeText(mode)) */
export function compactionModeText(mode: string): [string, string] {
  switch (mode) {
    case "toolcalls": return ["工具调用", "tool calls"];
    case "vault": return ["档案库", "vault"];
    case "truncated": return ["规则截断", "rule-based truncation"];
    default: return ["概览", "overview"];
  }
}

/** Context 面板使用的模式全称（与检查点行徽标的短标签区分）。 */
export function compactionModeNameText(mode: string): [string, string] {
  switch (mode) {
    case "toolcalls": return ["工具调用压缩", "Tool-call compaction"];
    case "vault": return ["档案库压缩", "Vault compaction"];
    case "truncated": return ["规则截断", "Rule-based truncation"];
    default: return ["概览压缩", "Overview compaction"];
  }
}

type LedgerCompaction = NonNullable<ContextView["ledger"]["compacted"]>;

/**
 * 从上下文账本还原检查点标记：
 * - 优先 compactionHistory（多次压缩逐条还原），缺省回退 compacted 单条（旧账本/未升级 server）；
 * - /clear 边界覆盖（cleared.uptoIndex ≥ record.uptoIndex）的过期记录不渲染——与 buildView 不再注入其摘要同口径；
 * - 记录自带 summary/instructions，可直接展开。
 */
export function deriveRestoredCompactions(view: ContextView | undefined): CompactionMarker[] {
  const ledger = view?.ledger;
  if (!ledger) return [];
  const records: LedgerCompaction[] = ledger.compactionHistory && ledger.compactionHistory.length > 0
    ? ledger.compactionHistory
    : ledger.compacted
      ? [ledger.compacted]
      : [];
  const clearedUpto = ledger.cleared?.uptoIndex ?? -1;
  return records
    .filter((record) => record.uptoIndex > clearedUpto)
    .map((record) => ({
      id: `compaction:${record.createdAt}`,
      uptoIndex: record.uptoIndex,
      mode: record.mode,
      // 历史记录无法区分手动/强制（账本不存该位），徽标只标模式
      forced: false,
      createdAt: record.createdAt,
      status: "settled" as const,
      ...(record.replacedTokens !== undefined ? { replacedTokens: record.replacedTokens } : {}),
      summary: record.summary,
      instructions: record.instructions,
    }));
}

/**
 * 合并实时标记与账本还原标记：createdAt 命中还原记录的实时已沉降标记由还原版取代
 *（还原版带 summary 可展开）；运行中/失败标记始终保留。输出按 createdAt 升序。
 */
export function mergeCompactionMarkers(live: CompactionMarker[], restored: CompactionMarker[]): CompactionMarker[] {
  const restoredIds = new Set(restored.map((marker) => marker.id));
  const merged = [...restored, ...live.filter((marker) => !restoredIds.has(marker.id))];
  return merged.sort((left, right) => {
    // 运行中/失败占位始终沉底（时间序未定）
    const leftLive = left.status !== "settled" ? 1 : 0;
    const rightLive = right.status !== "settled" ? 1 : 0;
    if (leftLive !== rightLive) return leftLive - rightLive;
    return left.createdAt.localeCompare(right.createdAt);
  });
}
