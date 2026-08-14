// context-manager 的类型定义（拆分自 context-manager.ts，纯类型无运行时代码）。
import type { ChatMessage } from "../sessions/types.js";
import type { Currency } from "./model-profile.js";

export interface RecordedCost {
  priced: boolean;
  source?: { currency: Currency; microUnits: string };
  usdMicroUnits?: string;
  cnyMicroUnits?: string;
  exchangeRate?: {
    rate: string;
    source: string;
    effectiveDate: string;
    fetchedAt: string;
  };
}

export interface CostLedger {
  usdMicroUnits: string;
  cnyMicroUnits: string;
  unpricedTokens: number;
  unavailableUsdTokens: number;
  unavailableCnyTokens: number;
  lastExchangeRate?: RecordedCost["exchangeRate"];
}

export type ToolEvictionStrategy = "lag" | "interval" | "off";

/** 驱逐形态：placeholder = 默认节省（占位符替换结果正文）；process = 超级节省（整轮工具过程连同思维链出视图）。 */
export type EvictionMode = "placeholder" | "process";

export interface ContextPolicy {
  enabled: boolean;
  strategy: ToolEvictionStrategy;
  evictionMode: EvictionMode;
  lag: number;
  interval: number;
  /** 结果估算 token 低于该值始终保留（小结果驱逐省不了多少，反而搅动缓存前缀）。 */
  minRetainTokens: number;
  /** read_file 结果被逐时头/尾各保留的行数（保住文件结构认知）。 */
  readKeepLines: number;
  pinExemptRounds: number;
  restoreBudget: number;
  maxSessionTokens?: number;
  maxSessionCost?: { currency: Currency; microUnits: string };
}

export interface LedgerEntry {
  messageId: string;
  kind: "tool_result";
  artifactId: string;
  state: "full" | "evicted" | "restored";
  createdRound: number;
  pinnedUntilRound: number;
  restoredAt?: string;
  /** 驱逐时记录的工具名与结果字节数，供占位符给出可操作的语义摘要（旧账本缺省，占位符相应降级）。 */
  toolName?: string;
  sizeBytes?: number;
  /** 驱逐时烧入的原文 token 估算（与视图归因同一估算器）；旧账本缺省，统计回退 sizeBytes/4。 */
  evictedTokens?: number;
  /** 结果是否为错误（exit ≠ 0 / isError），供超级节省的轮次摘要行标注。 */
  isError?: boolean;
  /** read_file 专属：头 readKeepLines 行 + 尾 readKeepLines 行的摘录（驱逐时烧入，写入后不可变）。
   *  带摘录的条目在两种模式下都保留配对留在视图，只替换正文。 */
  excerpt?: string;
}

/** 压缩记录：messages[0..uptoIndex) 由 summary 取代注入视图；instructions 为用户明确指令跨段累积。 */
export interface CompactionRecord {
  uptoIndex: number;
  mode: "toolcalls" | "overview" | "truncated" | "vault";
  summary: string;
  instructions: string[];
  createdAt: string;
  /** 被替换消息段的 token 估算（压缩时烧入，写入后不可变；旧记录缺省，UI 相应降级不显示）。 */
  replacedTokens?: number;
}


export interface ClearRecord {
  /** 活动路径空间边界：messages[0..uptoIndex) 被清空（与 compactor/agent 视图同口径）。 */
  uptoIndex: number;
  at: string;
  /**
   * 全量/活动路径双空间的定位锚点：/clear 时刻最后一条活动路径消息的 id。
   * buildView 与前端分隔线在自己持有的数组里按 id 定位（findIndex + 1），
   * 有分支/retry 离路径消息时不再因「活动路径长度 ≠ 全量下标」错位。
   * 旧 ledger（无此字段）回退 uptoIndex 语义。
   */
  uptoMessageId?: string;
}

export interface ContextLedger {
  version: 1;
  round: number;
  policy: ContextPolicy;
  entries: LedgerEntry[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: CostLedger;
  cacheBreakpoints: string[];
  compacted?: CompactionRecord;
  /** 历次压缩记录（含最新一次，与 compacted 同义重复末尾）：供 UI 在消息流中还原多个压缩检查点。 */
  compactionHistory?: CompactionRecord[];
  cleared?: ClearRecord;
}

export interface BudgetUpdate {
  maxSessionTokens?: number | undefined;
  maxSessionCost?: { currency: Currency; microUnits: string } | undefined;
}

export type ContextPolicyUpdate = Partial<Pick<ContextPolicy, "enabled" | "strategy" | "evictionMode" | "lag" | "interval" | "minRetainTokens" | "readKeepLines" | "pinExemptRounds" | "restoreBudget">>;

/**
 * 选择性上下文（§4.4）：pins 为消息 id 或文件路径（pin 的消息不被驱逐）；
 * excludes 为路径 glob（不进入上下文组装/repo map/索引）。
 * 注意：排除不是安全边界——文件访问权限仍由路径策略与沙盒保证。
 */
export interface ContextSelection {
  pins: string[];
  excludes: string[];
}

/** 按段 token 归因：system/repoMap 段由后续阶段（provider 侧/Phase 1c）供数，此处预留。 */
export interface ContextSegmentBreakdown {
  system: number;
  compactionSummary: number;
  toolResults: number;
  messages: number;
  repoMap: number;
  other: number;
}

export interface ContextBuildStats {
  totalTokens: number;
  segments: ContextSegmentBreakdown;
  /** 被 pin 的消息在视图中占用的估算 tokens；超预算时由调用方如实提示，不悄悄驱逐。 */
  pinnedTokens: number;
  /** 本次构建耗时（毫秒），为 0.5.0 性能基准留数据。 */
  buildMs: number;
  /** true 表示复用了上一 turn 的不可变前缀构建结果。 */
  incremental: boolean;
  /** 当前处于驱逐态的工具结果聚合：原文估算 tokens 与条数（restored/full 不计入）；无驱逐条目时缺省。 */
  evicted?: { tokens: number; count: number };
}

export interface ContextView {
  messages: ChatMessage[];
  ledger: ContextLedger;
  stats: ContextBuildStats;
}

export interface BuildViewOptions {
  selection?: ContextSelection;
  /** 强制全量重建（压缩、配置变更、会话恢复后的首次构建；等价性测试亦用）。 */
  forceFullRebuild?: boolean;
}

/** 视图中一条消息的构建片段：最终注入形态（驱逐占位/图像预算已应用）+ 预估算 tokens。 */
export interface ViewFragment {
  message: ChatMessage;
  tokens: number;
  segment: keyof ContextSegmentBreakdown;
  pinned: boolean;
}

/** 增量构建缓存：键校验通过后只需为追加消息构建新片段。 */
export interface ViewBuildCache {
  sourceIds: string[];
  ledgerKey: string;
  selectionKey: string;
  header?: ViewFragment | undefined;
  fragments: ViewFragment[];
  /** header+fragments 的累计统计：增量命中只需累加追加片段，不再全视图求和。 */
  totalTokens: number;
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
  /** 最终注入形态的主克隆（cache 私有，不外出）；每次返回按消息/内容数组浅拷。 */
  view: ChatMessage[];
}

/** ledger.json 内存缓存：size+mtimeMs+ctimeMs 指纹校验（同 session-store 消息缓存纪律），
 *  命中时免去 readFile+全量 JSON.parse；save 后重 stat 保持一致。ledgerKey 随缓存预算，
 *  只有落盘变更才重算。缓存持有规范副本——读取路径返回同一引用（只读约定），
 *  突变路径经 loadMutable 显式克隆或 beginTurn 的轮级句柄。 */
export interface LedgerCacheEntry {
  ledger: ContextLedger;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ledgerKey: string;
}

/** 轮级句柄的待落盘变更：fast path 跳过已即时应用的，rebase path 全部重放。 */
export interface PendingLedgerMutation {
  /** 应用到给定账本；返回 true 表示产生变更（仅驱逐可能空跑返回 false），void 视为已变更。 */
  apply: (ledger: ContextLedger) => boolean | void | Promise<boolean | void>;
  /** 已在工作副本即时应用：rebase 需重放，fast path 跳过。 */
  appliedToWorking: boolean;
}

/**
 * 轮级共享账本句柄（beginTurn 取得）：一轮内 budgetStatus/buildView/recordCacheBreakpoints/
 * recordUsage/advanceRound/evict 共用同一工作副本，commitTurn 统一落盘（有变更才写），
 * 把热路径的每轮多次全量克隆/落盘收敛为克隆 1 次 + 落盘至多 1 次。
 * 字段仅供 ContextManager 内部读写，调用方只需持有与透传。
 */
export interface TurnLedger {
  /** 本轮工作副本（含未落盘变更）；只读使用，切勿原地改。 */
  working: ContextLedger;
  /** beginTurn 时的缓存主本条目：commit 时若仍相同则工作副本即最新（fast path），否则重放变更。 */
  source: LedgerCacheEntry | undefined;
  pending: PendingLedgerMutation[];
  /** 确定产生变更（usage/轮次/断点）——驱逐可能空跑，不计入。 */
  mustSave: boolean;
  /** buildView 缓存键：轮内 key 相关字段（压缩/清空/模式/驱逐条目）不变，驱逐在 commit 才应用。 */
  ledgerKey: string | undefined;
}
