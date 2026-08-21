// context-manager 的纯函数与常量（拆分自 context-manager.ts）：缓存键、保留集、
// 驱逐占位/摘要/结构后处理、glob 排除、usage/cost 累加、账本清洗。行为与原实现逐字一致。
import type { ChatMessage } from "../sessions/types.js";
import { estimateTokens, IMAGE_TOKEN_ESTIMATE } from "./model-profile.js";
import type {
  ClearRecord,
  CompactionRecord,
  ContextLedger,
  ContextPolicy,
  ContextSegmentBreakdown,
  LedgerEntry,
  RecordedCost,
  ViewFragment,
} from "./context-types.js";

/** 压缩历史上限：超出丢弃最旧（compacted 始终保持最新一次，历史仅供 UI 回放多次压缩）。 */
const MAX_COMPACTION_HISTORY = 20;

const DEFAULT_POLICY: ContextPolicy = {
  enabled: true,
  strategy: "lag",
  evictionMode: "placeholder",
  // lag=10：保留最近 10 个 tool 轮的全文。活动路径以 tool 批次结尾时尾部批次是当轮
  //（模型尚未看到，始终保护）并计入这 10 轮——即当轮 + 最近 9 个已完成轮；
  // 路径以非 tool 消息结尾时则为最近 10 个已完成轮。更早的按 evictionMode 逐出为
  // artifact（占位符含 read_artifact 指引）。
  lag: 10,
  interval: 5,
  minRetainTokens: 256,
  readKeepLines: 50,
  pinExemptRounds: 5,
  restoreBudget: 64_000,
};

/** read 头尾摘录与驱逐豁免等驱逐侧常量/函数已迁至 extensions/context-saver（扩展能力）；本文件只保留核心视图组装所需的部分。 */

/** buildView 缓存键的 ledger 部分：压缩/清空/驱逐条目（与历史实现逐字节一致）。 */
export function computeLedgerKey(ledger: ContextLedger): string {
  return JSON.stringify({
    compacted: ledger.compacted ?? null,
    cleared: ledger.cleared ?? null,
    // evictionMode 改变视图渲染（结构后处理），必须参与缓存键
    mode: ledger.policy.evictionMode,
    entries: ledger.entries.map((entry) => [entry.messageId, entry.artifactId, entry.state]),
  });
}

/** 驱逐占位符：给模型可操作的摘要（工具名/大小）与自助恢复路径（read_artifact）。 */
function evictionPlaceholder(entry: LedgerEntry): string {
  const tool = entry.toolName ?? "unknown tool";
  const size = entry.sizeBytes !== undefined ? `, ${entry.sizeBytes} bytes` : "";
  return `[tool result evicted (${tool}${size}); artifact:${entry.artifactId}; call read_artifact with artifactId "${entry.artifactId}", offset and limit to re-read a slice]`;
}

/** 构建单条消息片段：深克隆 + 驱逐占位替换（pin 的消息跳过替换）。tokens/segments 在估算阶段回填。 */
export function buildFragment(message: ChatMessage, byMessage: Map<string, LedgerEntry>, pinnedIds: ReadonlySet<string>): ViewFragment {
  const entry = byMessage.get(message.id);
  const pinned = pinnedIds.has(message.id);
  const evictResult = entry && entry.state !== "full" && entry.state !== "restored" && !pinned;
  return {
    message: {
      ...message,
      content: message.content.map((block) => {
        if (!evictResult || block.type !== "tool_result") return { ...block };
        return {
          ...block,
          content: entry.excerpt ?? evictionPlaceholder(entry),
        };
      }),
    },
    tokens: 0,
    segments: emptySegments(),
    pinned,
  };
}

/** 空段归因桶；五分类键见 ContextSegmentBreakdown。 */
export function emptySegments(): ContextSegmentBreakdown {
  return { system: 0, input: 0, toolCalls: 0, output: 0, other: 0 };
}

/** 把 source 的各桶累加进 target（增量构建的段汇总用）。 */
export function addSegments(target: ContextSegmentBreakdown, source: ContextSegmentBreakdown): void {
  target.system += source.system;
  target.input += source.input;
  target.toolCalls += source.toolCalls;
  target.output += source.output;
  target.other += source.other;
}

/**
 * 与 estimateMessageTokens 逐块规则一致的单消息估算 + 按块段归因（调用方对总和再取 max(1, …)）。
 * 归因：user → input；assistant 的 text → output、tool_call → toolCalls、thinking/其他块 → other；
 * tool → toolCalls；每条消息的 4 tokens 结构开销计入角色默认桶（user→input / tool→toolCalls / assistant→output）。
 * 压缩摘要头（id 以 compaction: 开头的 user 角色合成消息）由调用方整体归入 other。
 */
export function measureFragment(message: ChatMessage): { tokens: number; segments: ContextSegmentBreakdown } {
  const segments = emptySegments();
  const roleBucket = message.role === "user" ? "input" : message.role === "tool" ? "toolCalls" : "output";
  let total = 4;
  segments[roleBucket] += 4;
  for (const block of message.content) {
    if (block.type === "image") {
      total += IMAGE_TOKEN_ESTIMATE;
      segments[roleBucket] += IMAGE_TOKEN_ESTIMATE;
    } else if (block.type === "tool_call") {
      const tokens = estimateTokens(JSON.stringify(block.input)) + 8;
      total += tokens;
      segments[message.role === "assistant" ? "toolCalls" : roleBucket] += tokens;
    } else if (block.type === "tool_result") {
      const tokens = estimateTokens(block.content);
      total += tokens;
      segments[message.role === "tool" ? "toolCalls" : roleBucket] += tokens;
    } else if (block.type === "text" || block.type === "thinking") {
      const tokens = estimateTokens(block.text);
      total += tokens;
      segments[block.type === "thinking" ? "other" : roleBucket] += tokens;
    } else if (block.type === "web_search_call") {
      // 仅回放元数据（服务端原始 item），按签名长度估算计入
      const tokens = estimateTokens(block.signature);
      total += tokens;
      segments[roleBucket] += tokens;
    }
  }
  return { tokens: total, segments };
}

/** 仅取 token 总数的兼容包装（压缩 replacedTokens 等只关心总量的调用方）。 */
export function estimateFragmentTokens(message: ChatMessage): number {
  return measureFragment(message).tokens;
}

/** 驱逐摘要消息 id 前缀：按轮一条，由该轮 assistant 消息 id 派生，确定且写入后不可变（缓存断点锚定用）。 */
const EVICTED_SUMMARY_PREFIX = "evicted:";

/** 超级节省轮次摘要行：列出被逐调用（含出错标记）与 artifact 恢复指引；内容仅由账本条目派生，不可变。 */
function renderEvictedRoundSummary(entries: LedgerEntry[]): string {
  const calls = entries.map((entry) => `${entry.toolName ?? "tool"}${entry.isError ? "(error)" : ""}`).join(", ");
  const artifacts = entries.map((entry) => entry.artifactId).join(", ");
  return `[${entries.length} tool call(s) evicted: ${calls}; artifacts: ${artifacts}; call read_artifact with an artifactId, offset and limit to re-read a slice]`;
}

/**
 * 超级节省（process）结构后处理：非保留轮的整轮工具过程出视图。
 * - read_file（带 excerpt 的条目）：配对保留，正文已被 buildFragment 换成头尾摘录，不动结构；
 * - 其余被逐结果：tool 消息整条移除，assistant 里对应 tool_call 块剥离；
 * - assistant 的 tool_call 被全部剥离时思维链一并移除（与工具过程同生共死），消息变空则整条丢弃；
 * - 每轮在原 assistant 位置后注入一条不可变摘要消息（id 由该轮 assistant 消息派生）。
 * 配对不变量：被删 tool 消息的 tool_call 一定同时被剥离，反之亦然（pin/restore/excerpt 两侧都保留）。
 */
export function applyProcessEviction(view: ChatMessage[], ledger: ContextLedger, pinnedIds: ReadonlySet<string>): ChatMessage[] {
  const entriesByMessage = new Map(
    ledger.entries
      .filter((entry) => entry.state !== "full" && entry.state !== "restored")
      .map((entry) => [entry.messageId, entry]),
  );
  if (entriesByMessage.size === 0) return view;
  const removedMessages = new Set<string>();
  const entryByCallId = new Map<string, LedgerEntry>();
  for (const message of view) {
    if (message.role !== "tool" || pinnedIds.has(message.id)) continue;
    const entry = entriesByMessage.get(message.id);
    if (!entry || entry.excerpt !== undefined) continue;
    const result = message.content.find((block) => block.type === "tool_result");
    if (!result || result.type !== "tool_result") continue;
    removedMessages.add(message.id);
    entryByCallId.set(result.toolCallId, entry);
  }
  if (removedMessages.size === 0) return view;

  const output: ChatMessage[] = [];
  for (const message of view) {
    if (removedMessages.has(message.id)) continue;
    if (message.role !== "assistant") {
      output.push(message);
      continue;
    }
    const removedEntries: LedgerEntry[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_call") continue;
      const entry = entryByCallId.get(block.id);
      if (entry) removedEntries.push(entry);
    }
    if (removedEntries.length === 0) {
      output.push(message);
      continue;
    }
    const hasSurvivingCall = message.content.some((block) => block.type === "tool_call" && !entryByCallId.has(block.id));
    // 思维链随整轮移除：该消息的 tool_call 全部出视图时才删 thinking；部分存活的轮保持原样
    const content = message.content.filter((block) => {
      if (block.type === "tool_call") return !entryByCallId.has(block.id);
      if (block.type === "thinking") return hasSurvivingCall;
      return true;
    });
    if (content.length > 0) output.push({ ...message, content });
    output.push({
      id: `${EVICTED_SUMMARY_PREFIX}${message.id}`,
      role: "user",
      createdAt: message.createdAt,
      content: [{ type: "text", text: renderEvictedRoundSummary(removedEntries) }],
    });
  }
  return output;
}

/** glob → RegExp 编译缓存：pattern 来自会话配置（≤200 条/会话），小 Map 足够；FIFO 逐出兜底防膨胀。 */
const globRegExpCache = new Map<string, RegExp>();
const MAX_CACHED_GLOB_REGEXPS = 256;

function globToRegExp(glob: string): RegExp {
  const cached = globRegExpCache.get(glob);
  if (cached) return cached;
  const normalized = glob.replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`, "i");
  globRegExpCache.set(glob, regex);
  while (globRegExpCache.size > MAX_CACHED_GLOB_REGEXPS) globRegExpCache.delete(globRegExpCache.keys().next().value!);
  return regex;
}

/**
 * 上下文排除钩子（§4.4）：判断路径是否命中会话排除清单（简单 glob：*、**、?）。
 * 排除只影响上下文组装/repo map/索引，不是安全边界——文件访问仍由路径策略与沙盒保证。
 * 无 / 的模式按 basename 匹配，含 / 的模式按规范化全路径匹配。
 */
export function isPathExcluded(target: string, excludes: readonly string[]): boolean {
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = normalized.split("/").pop() ?? normalized;
  for (const exclude of excludes) {
    const pattern = exclude.trim();
    if (!pattern) continue;
    const regex = globToRegExp(pattern);
    if (pattern.includes("/") ? regex.test(normalized) : regex.test(basename)) return true;
  }
  return false;
}


function normalizePolicy(value: ContextPolicy | undefined): ContextPolicy {
  const policy: ContextPolicy = { ...DEFAULT_POLICY, ...(value ?? {}) };
  if (policy.evictionMode !== "placeholder" && policy.evictionMode !== "process") policy.evictionMode = DEFAULT_POLICY.evictionMode;
  for (const key of ["minRetainTokens", "readKeepLines"] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) policy[key] = DEFAULT_POLICY[key];
  }
  const cost = value?.maxSessionCost;
  if (cost && (cost.currency === "USD" || cost.currency === "CNY") && /^[1-9]\d*$/.test(cost.microUnits)) {
    policy.maxSessionCost = { ...cost };
  } else {
    delete policy.maxSessionCost;
  }
  if (policy.maxSessionTokens !== undefined && (!Number.isSafeInteger(policy.maxSessionTokens) || policy.maxSessionTokens < 1)) {
    delete policy.maxSessionTokens;
  }
  return policy;
}

function isCompaction(value: unknown): value is CompactionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CompactionRecord>;
  return Number.isSafeInteger(record.uptoIndex) && (record.uptoIndex ?? -1) >= 0 &&
    typeof record.mode === "string" && ["toolcalls", "overview", "truncated", "vault"].includes(record.mode) &&
    typeof record.summary === "string" &&
    Array.isArray(record.instructions) &&
    typeof record.createdAt === "string" &&
    (record.replacedTokens === undefined || (Number.isSafeInteger(record.replacedTokens) && record.replacedTokens >= 0));
}

/** 历史条目统一清洗：过滤非法记录、instructions 只留字符串。 */
function normalizeCompaction(value: CompactionRecord): CompactionRecord {
  return { ...value, instructions: value.instructions.filter((item): item is string => typeof item === "string") };
}

/** 压缩写入统一入口（Compactor 与 compact-vault 扩展共用）：更新 compacted 并追加历史（超封顶丢最旧）。 */
export function recordCompaction(ledger: ContextLedger, record: CompactionRecord): void {
  ledger.compacted = record;
  const history = [...(ledger.compactionHistory ?? []), record];
  ledger.compactionHistory = history.slice(-MAX_COMPACTION_HISTORY);
}


/**
 * /clear 边界在给定消息数组中的下标：优先按 uptoMessageId 定位（id 之后第一条消息的下标，
 * 即 messages[0..result) 被清空），自动适配活动路径/全量两个空间；边界消息不在数组或旧
 * ledger 无 id 时回退 uptoIndex 下标语义（钳制到数组长度）。
 */
export function clearIndexIn(messages: ChatMessage[], cleared: ClearRecord): number {
  if (cleared.uptoMessageId) {
    const index = messages.findIndex((message) => message.id === cleared.uptoMessageId);
    if (index >= 0) return index + 1;
  }
  return Math.min(cleared.uptoIndex, messages.length);
}

/** 注入视图的压缩文本：用户明确指令累积置顶（§7.4 overview 契约）。 */
export function renderCompaction(record: CompactionRecord): string {
  if (record.instructions.length === 0) return record.summary;
  return [
    "用户明确指令（跨段累积，务必继续遵守）：",
    ...record.instructions.map((item) => `- ${item}`),
    "",
    record.summary,
  ].join("\n");
}

/** 图像独立预算（§7.3②）：视图中至多保留最新 MAX_IMAGES 张且不超 MAX_IMAGE_BYTES，更早的替换为占位文本。 */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function enforceImageBudget(view: ChatMessage[]): void {
  let count = 0;
  let bytes = 0;
  for (let m = view.length - 1; m >= 0; m -= 1) {
    const content = view[m]!.content;
    for (let b = content.length - 1; b >= 0; b -= 1) {
      const block = content[b]!;
      if (block.type !== "image") continue;
      // ref 形态（chat 落盘图）无内联 data：按 0 字节计入预算（保留最新若干张，由调用方内联）
      const size = Math.ceil((block.data?.length ?? 0) * 3 / 4);
      if (count < MAX_IMAGES && bytes + size <= MAX_IMAGE_BYTES) {
        count += 1;
        bytes += size;
      } else {
        content[b] = { type: "text", text: `[image omitted from LLM context: ${block.mediaType}, ${Math.round(size / 1024)}KB]` };
      }
    }
  }
}

export function normalizeLedger(value: Partial<ContextLedger>): ContextLedger {
  const usage = value.usage;
  const cost = value.cost;
  return {
    version: 1,
    round: Number.isSafeInteger(value.round) && (value.round ?? -1) >= 0 ? value.round! : 0,
    policy: normalizePolicy(value.policy),
    entries: Array.isArray(value.entries) ? value.entries : [],
    usage: {
      inputTokens: safeTokenCount(usage?.inputTokens),
      outputTokens: safeTokenCount(usage?.outputTokens),
      cacheRead: safeTokenCount(usage?.cacheRead),
      cacheWrite: safeTokenCount(usage?.cacheWrite),
    },
    cost: {
      usdMicroUnits: integerString(cost?.usdMicroUnits),
      cnyMicroUnits: integerString(cost?.cnyMicroUnits),
      unpricedTokens: safeTokenCount(cost?.unpricedTokens),
      unavailableUsdTokens: safeTokenCount(cost?.unavailableUsdTokens),
      unavailableCnyTokens: safeTokenCount(cost?.unavailableCnyTokens),
      ...(cost?.lastExchangeRate ? { lastExchangeRate: { ...cost.lastExchangeRate } } : {}),
    },
    cacheBreakpoints: Array.isArray(value.cacheBreakpoints)
      ? value.cacheBreakpoints.filter((item): item is string => typeof item === "string").slice(-3)
      : [],
    ...(isCompaction(value.compacted)
      ? { compacted: normalizeCompaction(value.compacted) }
      : {}),
    ...(Array.isArray(value.compactionHistory)
      ? { compactionHistory: value.compactionHistory.filter(isCompaction).map(normalizeCompaction).slice(-MAX_COMPACTION_HISTORY) }
      : {}),
    ...(value.cleared && Number.isSafeInteger(value.cleared.uptoIndex) && value.cleared.uptoIndex >= 0 && typeof value.cleared.at === "string" && Number.isFinite(Date.parse(value.cleared.at))
      ? { cleared: {
          uptoIndex: value.cleared.uptoIndex,
          at: value.cleared.at,
          ...(typeof value.cleared.uptoMessageId === "string" && value.cleared.uptoMessageId ? { uptoMessageId: value.cleared.uptoMessageId } : {}),
        } }
      : {}),
  };
}

export function selectCacheBreakpoints(messages: ChatMessage[], ledger: ContextLedger): string[] {
  // 单次尾部倒扫替代多处 O(n) 分配（Set/展开/取反/过滤），只取需要的尾部信息：
  // 最新 evicted 条目、视图内最新驱逐摘要、倒数第二条非摘要 user 消息，语义与原实现一致。
  const selected: string[] = [];
  // 最新 evicted 条目：entries 追加序即驱逐时间序，尾部倒扫首个命中即最新
  let lastEvictedId: string | undefined;
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]!;
    if (entry.state === "evicted") {
      lastEvictedId = entry.messageId;
      break;
    }
  }
  if (lastEvictedId !== undefined) {
    if (messages.some((message) => message.id === lastEvictedId)) {
      selected.push(lastEvictedId);
    } else {
      // 超级节省：被逐 tool 消息已出视图，锚到最新的驱逐摘要消息（同样位于稳定前缀边界）
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.id.startsWith(EVICTED_SUMMARY_PREFIX)) {
          selected.push(message.id);
          break;
        }
      }
    }
  }
  // 驱逐摘要消息是合成 user 消息，不参与"倒数第二条用户消息"断点：倒扫数到第 2 个即得
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.id.startsWith(EVICTED_SUMMARY_PREFIX)) continue;
    seen += 1;
    if (seen === 2) {
      selected.push(message.id);
      break;
    }
  }
  return [...new Set(selected)].slice(-3);
}

function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

/** 驱逐态条目聚合：tokens 优先取驱逐时烧入的估算，旧条目回退 sizeBytes/4，皆无只计条数。 */
export function aggregateEvicted(entries: LedgerEntry[]): { tokens: number; count: number } | undefined {
  let tokens = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.state !== "evicted") continue;
    count += 1;
    if (entry.evictedTokens !== undefined) tokens += entry.evictedTokens;
    else if (entry.sizeBytes !== undefined) tokens += Math.ceil(entry.sizeBytes / 4);
  }
  return count > 0 ? { tokens, count } : undefined;
}

function integerString(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}

function addIntegers(left: string, right: string): string {
  if (!/^\d+$/.test(right)) throw new Error("Cost must be a non-negative integer string");
  return (BigInt(left) + BigInt(right)).toString();
}

/** usage/成本累加（recordUsage 自载路径与轮级句柄重放共用；纯增量语义，天然可交换）。 */
export function applyUsage(
  ledger: ContextLedger,
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number },
  cost?: RecordedCost,
): void {
  ledger.usage.inputTokens += usage.inputTokens;
  ledger.usage.outputTokens += usage.outputTokens;
  ledger.usage.cacheRead += usage.cacheRead;
  ledger.usage.cacheWrite += usage.cacheWrite;
  if (cost) {
    const billedTokens = usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheWrite;
    if (!cost.priced) {
      ledger.cost.unpricedTokens += billedTokens;
    } else {
      if (!cost.usdMicroUnits) ledger.cost.unavailableUsdTokens += billedTokens;
      if (!cost.cnyMicroUnits) ledger.cost.unavailableCnyTokens += billedTokens;
    }
    if (cost.usdMicroUnits) ledger.cost.usdMicroUnits = addIntegers(ledger.cost.usdMicroUnits, cost.usdMicroUnits);
    if (cost.cnyMicroUnits) ledger.cost.cnyMicroUnits = addIntegers(ledger.cost.cnyMicroUnits, cost.cnyMicroUnits);
    if (cost.exchangeRate) ledger.cost.lastExchangeRate = { ...cost.exchangeRate };
  }
}
