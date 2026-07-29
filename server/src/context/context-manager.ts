import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import { estimateTokens, IMAGE_TOKEN_ESTIMATE, type Currency } from "./model-profile.js";

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

export interface ContextPolicy {
  enabled: boolean;
  strategy: ToolEvictionStrategy;
  lag: number;
  interval: number;
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
}

/** 压缩记录：messages[0..uptoIndex) 由 summary 取代注入视图；instructions 为用户明确指令跨段累积。 */
export interface CompactionRecord {
  uptoIndex: number;
  mode: "toolcalls" | "overview" | "truncated";
  summary: string;
  instructions: string[];
  createdAt: string;
}

export interface ClearRecord {
  uptoIndex: number;
  at: string;
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
  cleared?: ClearRecord;
}

export interface BudgetUpdate {
  maxSessionTokens?: number | undefined;
  maxSessionCost?: { currency: Currency; microUnits: string } | undefined;
}

export type ContextPolicyUpdate = Partial<Pick<ContextPolicy, "enabled" | "strategy" | "lag" | "interval" | "pinExemptRounds" | "restoreBudget">>;

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

const DEFAULT_POLICY: ContextPolicy = {
  enabled: true,
  strategy: "lag",
  lag: 1,
  interval: 5,
  pinExemptRounds: 5,
  restoreBudget: 20_000,
};

/** 视图中一条消息的构建片段：最终注入形态（驱逐占位/图像预算已应用）+ 预估算 tokens。 */
interface ViewFragment {
  message: ChatMessage;
  tokens: number;
  segment: keyof ContextSegmentBreakdown;
  pinned: boolean;
}

/** 增量构建缓存：键校验通过后只需为追加消息构建新片段。 */
interface ViewBuildCache {
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
 *  只有落盘变更才重算。 */
interface LedgerCacheEntry {
  ledger: ContextLedger;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ledgerKey: string;
}

const MAX_CACHED_LEDGERS = 32;
const MAX_CACHED_VIEWS = 32;

/** buildView 缓存键的 ledger 部分：压缩/清空/驱逐条目（与历史实现逐字节一致）。 */
function computeLedgerKey(ledger: ContextLedger): string {
  return JSON.stringify({
    compacted: ledger.compacted ?? null,
    cleared: ledger.cleared ?? null,
    entries: ledger.entries.map((entry) => [entry.messageId, entry.artifactId, entry.state]),
  });
}

/** 构建单条消息片段：深克隆 + 驱逐占位替换（pin 的消息跳过替换）。 */
function buildFragment(message: ChatMessage, byMessage: Map<string, LedgerEntry>, pinnedIds: ReadonlySet<string>): ViewFragment {
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
          content: `[tool result evicted; artifact:${entry.artifactId}; use the UI restore action to reinsert full text]`,
        };
      }),
    },
    tokens: 0,
    segment: message.role === "tool" ? "toolResults" : "messages",
    pinned,
  };
}

/** 与 estimateMessageTokens 逐块规则一致的单消息估算（调用方对总和再取 max(1, …)）。 */
function estimateFragmentTokens(message: ChatMessage): number {
  let total = 4;
  for (const block of message.content) {
    if (block.type === "image") total += IMAGE_TOKEN_ESTIMATE;
    else if (block.type === "tool_call") total += estimateTokens(JSON.stringify(block.input)) + 8;
    else if (block.type === "tool_result") total += estimateTokens(block.content);
    else if (block.type === "text" || block.type === "thinking") total += estimateTokens(block.text);
  }
  return total;
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

export class ContextManager {
  private static readonly operations = new Map<string, Promise<void>>();
  private static readonly viewCaches = new Map<string, ViewBuildCache>();
  private static readonly ledgerCaches = new Map<string, LedgerCacheEntry>();

  constructor(private readonly sessionRoot: string) {}

  async load(): Promise<ContextLedger> {
    return (await this.loadLedger()).ledger;
  }

  /**
   * 读取 ledger + 预算好的 buildView 缓存键。磁盘事实只在指纹（size/mtime/ctime）
   * 变化时重读；缓存主本不外出——调用方拿到 structuredClone，save 仍是唯一提交点。
   */
  private async loadLedger(): Promise<{ ledger: ContextLedger; ledgerKey: string }> {
    const target = path.join(this.sessionRoot, "ledger.json");
    const cached = ContextManager.ledgerCaches.get(this.sessionRoot);
    if (cached) {
      const info = await stat(target).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      const hit = cached.size < 0
        ? info === undefined
        : info !== undefined && info.size === cached.size && info.mtimeMs === cached.mtimeMs && info.ctimeMs === cached.ctimeMs;
      if (hit) {
        ContextManager.touchLedgerCache(this.sessionRoot, cached);
        return { ledger: structuredClone(cached.ledger), ledgerKey: cached.ledgerKey };
      }
    }
    let value: Partial<ContextLedger> = {};
    let fingerprint = { size: -1, mtimeMs: -1, ctimeMs: -1 };
    try {
      value = JSON.parse(await readFile(target, "utf8")) as Partial<ContextLedger>;
      const info = await stat(target);
      fingerprint = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const ledger = normalizeLedger(value);
    const entry: LedgerCacheEntry = { ledger, ...fingerprint, ledgerKey: computeLedgerKey(ledger) };
    ContextManager.touchLedgerCache(this.sessionRoot, entry);
    return { ledger: structuredClone(ledger), ledgerKey: entry.ledgerKey };
  }

  async save(ledger: ContextLedger): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    const target = path.join(this.sessionRoot, "ledger.json");
    await writeUtf8Atomically(target, `${JSON.stringify(ledger, null, 2)}\n`);
    // 落盘即提交点：重 stat 更新缓存主本（克隆隔离，调用方后续改动不影响缓存）。
    const info = await stat(target);
    ContextManager.touchLedgerCache(this.sessionRoot, {
      ledger: structuredClone(ledger),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ledgerKey: computeLedgerKey(ledger),
    });
  }

  private static touchLedgerCache(sessionRoot: string, entry: LedgerCacheEntry): void {
    ContextManager.ledgerCaches.delete(sessionRoot);
    ContextManager.ledgerCaches.set(sessionRoot, entry);
    while (ContextManager.ledgerCaches.size > MAX_CACHED_LEDGERS) {
      ContextManager.ledgerCaches.delete(ContextManager.ledgerCaches.keys().next().value!);
    }
  }

  private static touchViewCache(sessionRoot: string, cache: ViewBuildCache): void {
    ContextManager.viewCaches.delete(sessionRoot);
    ContextManager.viewCaches.set(sessionRoot, cache);
    while (ContextManager.viewCaches.size > MAX_CACHED_VIEWS) {
      ContextManager.viewCaches.delete(ContextManager.viewCaches.keys().next().value!);
    }
  }

  async buildView(messages: ChatMessage[], options?: BuildViewOptions): Promise<ContextView> {
    const startedAt = performance.now();
    const { ledger, ledgerKey } = await this.loadLedger();
    const selection: ContextSelection = { pins: options?.selection?.pins ?? [], excludes: options?.selection?.excludes ?? [] };
    const pinnedIds = new Set(selection.pins);
    const compacted = ledger.compacted;
    const compactedIndex = compacted ? Math.min(compacted.uptoIndex, messages.length) : 0;
    const clearedIndex = ledger.cleared ? Math.min(ledger.cleared.uptoIndex, messages.length) : 0;
    // 压缩和清空都裁剪消息前缀；较新的边界获胜。clear 覆盖压缩时不得重新注入旧摘要。
    const uptoIndex = Math.max(compactedIndex, clearedIndex);

    // 增量复用（§4.4）：缓存键覆盖所有影响注入字节的输入——ledger 的压缩/清空/驱逐条目
    // 与 pin/排除配置。压缩、驱逐、恢复、配置变更都会改变键值而自然触发全量重建；
    // 会话恢复截断消息则令前缀校验失败。缓存只复用计算，最终产出字节与全量重建一致。
    // ledgerKey 随 ledger 内存缓存预算，仅落盘变更时重算（见 loadLedger/save）。
    const selectionKey = JSON.stringify(selection);

    const cached = ContextManager.viewCaches.get(this.sessionRoot);
    let incremental = false;
    let header: ViewFragment | undefined;
    let fragments: ViewFragment[] | undefined;
    let sourceIds: string[] | undefined;
    let total = 0;
    let pinnedTokens = 0;
    let segments: ContextSegmentBreakdown | undefined;
    let master: ChatMessage[] | undefined;
    if (!options?.forceFullRebuild && cached
        && cached.ledgerKey === ledgerKey && cached.selectionKey === selectionKey
        && cached.sourceIds.length <= messages.length
        && cached.sourceIds.every((id, index) => messages[index]!.id === id)) {
      // 追加消息含图片时，图像预算的占位替换会回溯到前缀，必须全量重建。
      const appended = messages.slice(cached.sourceIds.length);
      if (!appended.some((message) => message.content.some((block) => block.type === "image"))) {
        ContextManager.touchViewCache(this.sessionRoot, cached);
        header = cached.header;
        fragments = [...cached.fragments];
        sourceIds = [...cached.sourceIds];
        total = cached.totalTokens;
        pinnedTokens = cached.pinnedTokens;
        segments = { ...cached.segments };
        master = [...cached.view];
        const byMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
        for (const message of appended) {
          const fragment = buildFragment(message, byMessage, pinnedIds);
          // 追加消息不含图片（否则已回退全量），可立即完成该片段的 token 估算。
          fragment.tokens = estimateFragmentTokens(fragment.message);
          fragments.push(fragment);
          sourceIds.push(message.id);
          total += fragment.tokens;
          segments[fragment.segment] += fragment.tokens;
          if (fragment.pinned) pinnedTokens += fragment.tokens;
          // buildFragment 产出已是私有深克隆，直接入主克隆数组，不再二次克隆。
          master.push(fragment.message);
        }
        incremental = true;
      }
    }
    if (!fragments) {
      const byMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
      fragments = messages.slice(uptoIndex).map((message) => buildFragment(message, byMessage, pinnedIds));
      if (compacted && (!ledger.cleared || compactedIndex > clearedIndex)) {
        header = {
          message: {
            id: `compaction:${compacted.createdAt}`,
            role: "user",
            createdAt: compacted.createdAt,
            content: [{ type: "text", text: `[Earlier context compacted (${compacted.mode})]\n${renderCompaction(compacted)}` }],
          },
          segment: "compactionSummary",
          pinned: false,
          tokens: 0,
        };
      }
      // 图像独立预算作用于整个视图（从尾部计数），只在全量构建时应用。
      enforceImageBudget(fragments.map((fragment) => fragment.message));
      const rebuilt = header ? [header, ...fragments] : fragments;
      // token 估算与统计累加同一趟完成；片段消息已是 buildFragment 的私有克隆，
      // 图像预算也已应用，直接作为主克隆，省掉过去整视图的一次额外逐块克隆。
      segments = { system: 0, compactionSummary: 0, toolResults: 0, messages: 0, repoMap: 0, other: 0 };
      for (const fragment of rebuilt) {
        fragment.tokens = estimateFragmentTokens(fragment.message);
        total += fragment.tokens;
        segments[fragment.segment] += fragment.tokens;
        if (fragment.pinned) pinnedTokens += fragment.tokens;
      }
      master = rebuilt.map((fragment) => fragment.message);
      sourceIds = messages.map((message) => message.id);
    }
    const stats: ContextBuildStats = {
      totalTokens: Math.max(1, total),
      segments: segments!,
      pinnedTokens,
      buildMs: performance.now() - startedAt,
      incremental,
    };
    ContextManager.touchViewCache(this.sessionRoot, {
      sourceIds: sourceIds!, ledgerKey, selectionKey, header, fragments,
      totalTokens: total, segments: { ...segments! }, pinnedTokens, view: master!,
    });
    // 返回按消息/内容数组浅拷：调用方（扩展 transform 等）可替换消息或内容数组而不污染
    // 缓存主本；内容块按不可变数据共享（现有调用方均为整体替换或 IPC 序列化，无原地改写）。
    const view = master!.map((message) => ({ ...message, content: [...message.content] }));
    return { messages: view, ledger, stats };
  }

  async budgetStatus(): Promise<{
    token: { limit?: number; used: number; paused: boolean };
    cost: { limit?: { currency: Currency; microUnits: string }; usedMicroUnits: string; paused: boolean; reason?: "cost_exhausted" | "cost_unavailable" };
    paused: boolean;
  }> {
    const ledger = await this.load();
    const tokenUsed = ledger.usage.inputTokens + ledger.usage.outputTokens;
    const tokenLimit = ledger.policy.maxSessionTokens;
    const tokenPaused = tokenLimit !== undefined && tokenUsed >= tokenLimit;
    const costLimit = ledger.policy.maxSessionCost;
    const usedMicroUnits = costLimit?.currency === "CNY" ? ledger.cost.cnyMicroUnits : ledger.cost.usdMicroUnits;
    const unavailableTokens = costLimit?.currency === "CNY" ? ledger.cost.unavailableCnyTokens : ledger.cost.unavailableUsdTokens;
    const costUnavailable = costLimit !== undefined &&
      (ledger.cost.unpricedTokens > 0 || unavailableTokens > 0);
    const costPaused = costLimit !== undefined && (costUnavailable || BigInt(usedMicroUnits) >= BigInt(costLimit.microUnits));
    return {
      token: { ...(tokenLimit === undefined ? {} : { limit: tokenLimit }), used: tokenUsed, paused: tokenPaused },
      cost: {
        ...(costLimit === undefined ? {} : { limit: { ...costLimit } }),
        usedMicroUnits,
        paused: costPaused,
        ...(costPaused ? { reason: costUnavailable ? "cost_unavailable" as const : "cost_exhausted" as const } : {}),
      },
      paused: tokenPaused || costPaused,
    };
  }

  async updateBudget(update: BudgetUpdate): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      if ("maxSessionTokens" in update) {
        const value = update.maxSessionTokens;
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new Error("maxSessionTokens must be a positive integer");
        }
        if (value === undefined) delete ledger.policy.maxSessionTokens;
        else ledger.policy.maxSessionTokens = value;
      }
      if ("maxSessionCost" in update) {
        const value = update.maxSessionCost;
        if (value !== undefined &&
            (!/^[1-9]\d*$/.test(value.microUnits) || !["USD", "CNY"].includes(value.currency))) {
          throw new Error("maxSessionCost must contain a positive integer microUnits and USD or CNY currency");
        }
        if (value === undefined) delete ledger.policy.maxSessionCost;
        else ledger.policy.maxSessionCost = { ...value };
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async updatePolicy(update: ContextPolicyUpdate): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      if (update.enabled !== undefined) {
        if (typeof update.enabled !== "boolean") throw new Error("enabled must be a boolean");
        ledger.policy.enabled = update.enabled;
      }
      if (update.strategy !== undefined) {
        if (!["lag", "interval", "off"].includes(update.strategy)) throw new Error("strategy must be lag, interval, or off");
        ledger.policy.strategy = update.strategy;
      }
      for (const key of ["lag", "interval", "pinExemptRounds", "restoreBudget"] as const) {
        const value = update[key];
        if (value === undefined) continue;
        const minimum = key === "interval" || key === "restoreBudget" ? 1 : 0;
        if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
        ledger.policy[key] = value;
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async setBudget(
    maxSessionTokens: number | undefined,
    maxSessionCost: { currency: Currency; microUnits: string } | undefined,
  ): Promise<ContextLedger> {
    return this.updateBudget({ maxSessionTokens, maxSessionCost });
  }

  async setTokenBudget(maxSessionTokens: number | undefined): Promise<ContextLedger> {
    return this.updateBudget({ maxSessionTokens });
  }

  async recordUsage(
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number },
    cost?: RecordedCost,
  ): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
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
      await this.save(ledger);
      return ledger;
    });
  }

  async updateLedger(update: (ledger: ContextLedger) => void): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      update(ledger);
      await this.save(ledger);
      return ledger;
    });
  }

  async markCleared(uptoIndex: number): Promise<ContextLedger> {
    if (!Number.isSafeInteger(uptoIndex) || uptoIndex < 0) throw new Error("Clear index must be a non-negative integer");
    return this.updateLedger((ledger) => {
      ledger.cleared = { uptoIndex, at: new Date().toISOString() };
    });
  }

  async replaceLedger(value: unknown): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = normalizeLedger(value && typeof value === "object" ? value as Partial<ContextLedger> : {});
      await this.save(ledger);
      return ledger;
    });
  }

  async recordCacheBreakpoints(messageIds: string[]): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const next = [...new Set(messageIds)].slice(-3);
      // 内容未变时跳过落盘（热路径每轮都调用，多数轮断点不变）。
      if (next.length === ledger.cacheBreakpoints.length && next.every((id, index) => id === ledger.cacheBreakpoints[index])) {
        return ledger;
      }
      ledger.cacheBreakpoints = next;
      await this.save(ledger);
      return ledger;
    });
  }

  async advanceRound(): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      ledger.round += 1;
      await this.save(ledger);
      return ledger;
    });
  }

  async evict(messages: ChatMessage[], pinnedIds?: ReadonlySet<string>): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const toolMessages = messages.filter((message) => message.role === "tool");
      if (!ledger.policy.enabled || ledger.policy.strategy === "off") return ledger;
      const eligible = ledger.policy.strategy === "lag"
        ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
        : ledger.policy.strategy === "interval" && ledger.round % Math.max(1, ledger.policy.interval) === 0
          ? toolMessages.slice(0, Math.max(0, toolMessages.length - ledger.policy.lag))
          : [];
      // Ledger entries grow with the session. Index them once so eviction stays
      // linear in the newly eligible tool messages instead of O(T×E).
      const entriesByMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
      // artifacts 目录 mkdir 每轮最多一次（原来每条被驱逐消息一次 recursive mkdir）。
      let artifactsDirReady = false;
      let mutated = false;
      for (const message of eligible) {
        // pin 的消息不被驱逐；pin 占用超预算时由构建统计如实上报，不在这里悄悄绕过。
        if (pinnedIds?.has(message.id)) continue;
        const existing = entriesByMessage.get(message.id);
        if (existing) {
          if (existing.pinnedUntilRound >= ledger.round) continue;
          if (existing.state !== "evicted" || existing.restoredAt !== undefined) {
            existing.state = "evicted";
            delete existing.restoredAt;
            mutated = true;
          }
          continue;
        }
        const result = message.content.find((block) => block.type === "tool_result");
        if (!result || result.type !== "tool_result") continue;
        const artifactId = `artifact-${randomUUID()}`;
        if (!artifactsDirReady) {
          await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
          artifactsDirReady = true;
        }
        await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
        const entry: LedgerEntry = { messageId: message.id, kind: "tool_result", artifactId, state: "evicted", createdRound: ledger.round, pinnedUntilRound: 0 };
        ledger.entries.push(entry);
        entriesByMessage.set(entry.messageId, entry);
        mutated = true;
      }
      // 无新增/状态变化时跳过落盘（lag 窗口内多数轮 eligible 为空或已全部驱逐）。
      if (mutated) await this.save(ledger);
      return ledger;
    });
  }

  async evictMessage(messages: ChatMessage[], messageId: string): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const message = messages.find((item) => item.id === messageId && item.role === "tool");
      if (!message) throw new Error("Tool result message not found");
      const existing = ledger.entries.find((entry) => entry.messageId === messageId);
      if (existing) {
        existing.state = "evicted";
        existing.pinnedUntilRound = 0;
        delete existing.restoredAt;
      } else {
        const result = message.content.find((block) => block.type === "tool_result");
        if (!result || result.type !== "tool_result") throw new Error("Message has no tool result");
        const artifactId = `artifact-${randomUUID()}`;
        await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
        await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
        ledger.entries.push({ messageId, kind: "tool_result", artifactId, state: "evicted", createdRound: ledger.round, pinnedUntilRound: 0 });
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async setPinned(messageId: string, pinned: boolean): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
      if (!entry) throw new Error("Context entry not found");
      entry.pinnedUntilRound = pinned ? Number.MAX_SAFE_INTEGER : 0;
      await this.save(ledger);
      return ledger;
    });
  }

  async readArtifact(artifactId: string, offset: number, limit: number): Promise<string> {
    if (!/^artifact-[0-9a-f-]{36}$/.test(artifactId)) throw new Error("Invalid artifact ID");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000) throw new Error("limit must be between 1 and 64000");
    try {
      const content = await readFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), "utf8");
      return content.slice(offset, offset + limit);
    } catch (error) {
      if (isMissing(error)) throw new Error("Artifact not found");
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = ContextManager.operations.get(this.sessionRoot) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    ContextManager.operations.set(this.sessionRoot, settled);
    void settled.finally(() => {
      if (ContextManager.operations.get(this.sessionRoot) === settled) {
        ContextManager.operations.delete(this.sessionRoot);
      }
    });
    return result;
  }

  async restore(messageId: string): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.load();
      const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
      if (!entry) throw new Error("No evicted tool result for message");
      entry.state = "restored";
      entry.restoredAt = new Date().toISOString();
      entry.pinnedUntilRound = ledger.round + ledger.policy.pinExemptRounds;
      // restoreBudget 约束的是受保护的回写总量：超额时从最早回写项开始提前解除 pin，
      // 内容仍保留到下一次正常驱逐，避免一次点击造成 UI 抖动。
      const restored = ledger.entries
        .filter((candidate) => candidate.state === "restored" && candidate.pinnedUntilRound > ledger.round)
        .sort((left, right) => (left.restoredAt ?? "").localeCompare(right.restoredAt ?? ""));
      const sizes = new Map<string, number>();
      let estimatedTokens = 0;
      for (const candidate of restored) {
        const bytes = await stat(path.join(this.sessionRoot, "artifacts", `${candidate.artifactId}.txt`)).then((value) => value.size).catch(() => 0);
        const tokens = Math.ceil(bytes / 4);
        sizes.set(candidate.messageId, tokens);
        estimatedTokens += tokens;
      }
      for (const candidate of restored) {
        if (estimatedTokens <= ledger.policy.restoreBudget) break;
        candidate.pinnedUntilRound = 0;
        estimatedTokens -= sizes.get(candidate.messageId) ?? 0;
      }
      await this.save(ledger);
      return ledger;
    });
  }
}

function normalizePolicy(value: ContextPolicy | undefined): ContextPolicy {
  const policy: ContextPolicy = { ...DEFAULT_POLICY, ...(value ?? {}) };
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
    typeof record.mode === "string" && ["toolcalls", "overview", "truncated"].includes(record.mode) &&
    typeof record.summary === "string" &&
    Array.isArray(record.instructions) &&
    typeof record.createdAt === "string";
}

/** 注入视图的压缩文本：用户明确指令累积置顶（§7.4 overview 契约）。 */
function renderCompaction(record: CompactionRecord): string {
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

function enforceImageBudget(view: ChatMessage[]): void {
  let count = 0;
  let bytes = 0;
  for (let m = view.length - 1; m >= 0; m -= 1) {
    const content = view[m]!.content;
    for (let b = content.length - 1; b >= 0; b -= 1) {
      const block = content[b]!;
      if (block.type !== "image") continue;
      const size = Math.ceil(block.data.length * 3 / 4);
      if (count < MAX_IMAGES && bytes + size <= MAX_IMAGE_BYTES) {
        count += 1;
        bytes += size;
      } else {
        content[b] = { type: "text", text: `[image omitted from LLM context: ${block.mediaType}, ${Math.round(size / 1024)}KB]` };
      }
    }
  }
}

function normalizeLedger(value: Partial<ContextLedger>): ContextLedger {
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
      ? { compacted: { ...value.compacted, instructions: value.compacted.instructions.filter((item): item is string => typeof item === "string") } }
      : {}),
    ...(value.cleared && Number.isSafeInteger(value.cleared.uptoIndex) && value.cleared.uptoIndex >= 0 && typeof value.cleared.at === "string" && Number.isFinite(Date.parse(value.cleared.at))
      ? { cleared: { uptoIndex: value.cleared.uptoIndex, at: value.cleared.at } }
      : {}),
  };
}

export function selectCacheBreakpoints(messages: ChatMessage[], ledger: ContextLedger): string[] {
  const selected: string[] = [];
  const lastEvicted = [...ledger.entries].reverse().find((entry) => entry.state === "evicted");
  if (lastEvicted) selected.push(lastEvicted.messageId);
  const users = messages.filter((message) => message.role === "user");
  if (users.length >= 2) selected.push(users[users.length - 2]!.id);
  return [...new Set(selected)].slice(-3);
}

function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function integerString(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}

function addIntegers(left: string, right: string): string {
  if (!/^\d+$/.test(right)) throw new Error("Cost must be a non-negative integer string");
  return (BigInt(left) + BigInt(right)).toString();
}
