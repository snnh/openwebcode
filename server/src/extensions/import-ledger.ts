/**
 * 扩展 `sessions.import` 的可选账本入参净化（纯函数，无 IO）。
 *
 * 信任边界：`sessions.import` 的 `ledger` 由扩展（Extension Host 子进程）下发，扩展可能把任意外部
 * JSON（如 dsh 会话文件里的压缩摘要）直接塞进来。落盘前必须**限形 + 限量**：
 * - 限量：`summary` 截断到 {@link IMPORT_SUMMARY_MAX_LENGTH}、`compactionHistory` 只留最近
 *   {@link IMPORT_COMPACTION_HISTORY_LIMIT} 条、`entries` 上限 {@link IMPORT_ENTRIES_LIMIT} 条——
 *   否则一份畸形账本能把 ledger.json 撑到几十 MB，之后每次读会话都要解析它；
 * - 限形：`entries` 逐条只保留 `messageId`/`state`/`artifactId`/`createdRound`/`pinnedUntilRound`
 *   这三个必需 + 两个可选的字符串/整数形状（`toolName`/`sizeBytes`/`excerpt` 等展示字段由核心
 *   `normalizeLedger` 的缺省口径兜底），其余键一律丢弃（不把来路不明的字段写进核心账本）。
 *
 * 拒绝策略：顶层不是一个对象、或 `entries` 不是数组（即「这压根不是账本」）→ 返回 undefined，
 * 调用方不落账本（账本懒建为空的最小账本，比写一份垃圾账本安全）。单条畸形条目只丢该条。
 */

/** `compacted.summary` 的字符上限（超出截断并在末尾标注）。 */
export const IMPORT_SUMMARY_MAX_LENGTH = 100_000;

/** `compactionHistory` 保留的最大条数（超出取最近的，与核心 `MAX_COMPACTION_HISTORY` 同口径）。 */
export const IMPORT_COMPACTION_HISTORY_LIMIT = 20;

/** `entries` 保留的最大条数（超出取最近的）。 */
export const IMPORT_ENTRIES_LIMIT = 2000;

/** 截断标注后缀（与子代理转录截断同款措辞）。 */
const TRUNCATED_SUFFIX = "…(truncated)";

/** 未知 JSON 值取纯对象视图（数组/null/标量返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 非空字符串判定。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 截断到上限（超长时带 {@link TRUNCATED_SUFFIX}）。 */
function truncateSummary(text: string): string {
  if (text.length <= IMPORT_SUMMARY_MAX_LENGTH) return text;
  return `${text.slice(0, IMPORT_SUMMARY_MAX_LENGTH)}${TRUNCATED_SUFFIX}`;
}

/**
 * 净化 `compacted`（导出方向只用到 `summary`，但核心账本要求 `uptoIndex`/`mode`/`instructions`/
 * `createdAt` 齐备，缺项时宁可放弃整个 `compacted`——写一份半截压缩记录会让视图裁剪错位）。
 * @param raw - 原始 `compacted`。
 * @returns 净化后的压缩记录；形状不成立时 undefined（调用方不写该字段）。
 */
function sanitizeCompacted(raw: unknown): Record<string, unknown> | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const uptoIndex = record.uptoIndex;
  const summary = record.summary;
  if (typeof uptoIndex !== "number" || !Number.isSafeInteger(uptoIndex) || uptoIndex < 0) return undefined;
  if (typeof summary !== "string") return undefined;
  const mode = typeof record.mode === "string" ? record.mode : undefined;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : undefined;
  if (mode === undefined || createdAt === undefined) return undefined;
  return {
    uptoIndex,
    ...(isNonEmptyString(record.uptoMessageId) ? { uptoMessageId: record.uptoMessageId } : {}),
    mode,
    summary: truncateSummary(summary),
    instructions: Array.isArray(record.instructions)
      ? record.instructions.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [],
    createdAt,
    ...(typeof record.replacedTokens === "number" && Number.isSafeInteger(record.replacedTokens) && record.replacedTokens >= 0
      ? { replacedTokens: record.replacedTokens }
      : {}),
  };
}

/**
 * 净化 `compactionHistory`（只留最近的 {@link IMPORT_COMPACTION_HISTORY_LIMIT} 条合法记录）。
 * @param raw - 原始 `compactionHistory`。
 * @returns 净化后的数组；原始值不是数组时 undefined（调用方不写该字段）。
 */
function sanitizeCompactionHistory(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const records: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    const record = sanitizeCompacted(item);
    if (record !== undefined) records.push(record);
  }
  return records.slice(-IMPORT_COMPACTION_HISTORY_LIMIT);
}

/**
 * 净化单条账本条目：只保留核心 `LedgerEntry` 的必需字段与两个整数轮次字段。
 *
 * `messageId`/`state` 非空字符串、`artifactId` 给了就必须是非空字符串；`createdRound`/`pinnedUntilRound`
 * 给了就必须是非负安全整数（否则丢弃该字段用核心缺省）。缺 `messageId` 或 `state` → 整条丢弃。
 * @param raw - 原始条目。
 * @returns 净化后的条目；形状不成立时 undefined。
 */
function sanitizeEntry(raw: unknown): Record<string, unknown> | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  if (!isNonEmptyString(record.messageId) || !isNonEmptyString(record.state)) return undefined;
  if (record.artifactId !== undefined && !isNonEmptyString(record.artifactId)) return undefined;
  const round = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const createdRound = round(record.createdRound);
  const pinnedUntilRound = round(record.pinnedUntilRound);
  return {
    messageId: record.messageId,
    state: record.state,
    ...(record.artifactId === undefined ? {} : { artifactId: record.artifactId }),
    ...(createdRound === undefined ? {} : { createdRound }),
    ...(pinnedUntilRound === undefined ? {} : { pinnedUntilRound }),
  };
}

/**
 * 净化 `sessions.import` 的 `ledger` 入参。
 *
 * 只做「限形 + 限量」，不补齐核心缺省字段（缺省由 `ContextManager.replaceLedger` 的
 * `normalizeLedger` 统一兜底——信任边界只有一处，避免两处归一化口径漂移）。
 * `entries` 的「缺省」与「非法」刻意分开：缺省（`undefined`）视为「本次不带条目」（核心
 * `normalizeLedger` 按空数组兜底），不能因此把整份账本丢掉——导入路径只需要 `compacted`
 * （压缩摘要 + 锚点），丢掉它等于把压缩导入静默降级；而 `entries` 存在却**不是数组**时说明
 * 调用方发来的根本不是账本，按整体非法处理。
 * @param value - 扩展下发的 `ledger`（任意 JSON）。
 * @returns 可安全交给 `replaceLedger` 的账本对象；值不是账本形状（非对象 / `entries` 存在但非数组）
 *   时 undefined（调用方不落账本）。
 */
export function sanitizeImportLedger(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (record.entries !== undefined && !Array.isArray(record.entries)) return undefined;
  const entries: Array<Record<string, unknown>> = [];
  for (const item of (Array.isArray(record.entries) ? record.entries : [])) {
    const entry = sanitizeEntry(item);
    if (entry !== undefined) entries.push(entry);
  }
  const compacted = sanitizeCompacted(record.compacted);
  const compactionHistory = sanitizeCompactionHistory(record.compactionHistory);
  const round = typeof record.round === "number" && Number.isSafeInteger(record.round) && record.round >= 0 ? record.round : undefined;
  // 白名单式输出：核心账本认识的其余字段（policy/usage/cost/cacheBreakpoints/cleared）原样透传，
  // 由 `normalizeLedger` 逐字段校验；**不认识**的顶层键与坏掉的 compacted/compactionHistory 一律不落。
  return {
    entries: entries.slice(-IMPORT_ENTRIES_LIMIT),
    ...(round === undefined ? {} : { round }),
    ...(record.policy === undefined ? {} : { policy: record.policy }),
    ...(record.usage === undefined ? {} : { usage: record.usage }),
    ...(record.cost === undefined ? {} : { cost: record.cost }),
    ...(record.cacheBreakpoints === undefined ? {} : { cacheBreakpoints: record.cacheBreakpoints }),
    ...(record.cleared === undefined ? {} : { cleared: record.cleared }),
    ...(compacted === undefined ? {} : { compacted }),
    ...(compactionHistory === undefined ? {} : { compactionHistory }),
  };
}
