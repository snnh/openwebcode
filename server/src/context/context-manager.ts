import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
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

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
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

  constructor(private readonly sessionRoot: string) {}

  async load(): Promise<ContextLedger> {
    try {
      const ledger = JSON.parse(await readFile(path.join(this.sessionRoot, "ledger.json"), "utf8")) as Partial<ContextLedger>;
      return normalizeLedger(ledger);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return normalizeLedger({});
    }
  }

  async save(ledger: ContextLedger): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    const target = path.join(this.sessionRoot, "ledger.json");
    await writeUtf8Atomically(target, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  async buildView(messages: ChatMessage[], options?: BuildViewOptions): Promise<ContextView> {
    const startedAt = performance.now();
    const ledger = await this.load();
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
    const ledgerKey = JSON.stringify({
      compacted: ledger.compacted ?? null,
      cleared: ledger.cleared ?? null,
      entries: ledger.entries.map((entry) => [entry.messageId, entry.artifactId, entry.state]),
    });
    const selectionKey = JSON.stringify(selection);
    const sourceIds = messages.map((message) => message.id);

    const cached = ContextManager.viewCaches.get(this.sessionRoot);
    let incremental = false;
    let header: ViewFragment | undefined;
    let fragments: ViewFragment[] | undefined;
    if (!options?.forceFullRebuild && cached
        && cached.ledgerKey === ledgerKey && cached.selectionKey === selectionKey
        && cached.sourceIds.length <= sourceIds.length
        && cached.sourceIds.every((id, index) => id === sourceIds[index])) {
      // 追加消息含图片时，图像预算的占位替换会回溯到前缀，必须全量重建。
      const appended = messages.slice(cached.sourceIds.length);
      if (!appended.some((message) => message.content.some((block) => block.type === "image"))) {
        header = cached.header;
        fragments = [...cached.fragments];
        const byMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
        for (const message of appended) {
          const fragment = buildFragment(message, byMessage, pinnedIds);
          // 追加消息不含图片（否则已回退全量），可立即完成该片段的 token 估算。
          fragment.tokens = estimateFragmentTokens(fragment.message);
          fragments.push(fragment);
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
      for (const fragment of rebuilt) fragment.tokens = estimateFragmentTokens(fragment.message);
    }
    const all = header ? [header, ...fragments] : fragments;
    const segments: ContextSegmentBreakdown = { system: 0, compactionSummary: 0, toolResults: 0, messages: 0, repoMap: 0, other: 0 };
    let total = 0;
    let pinnedTokens = 0;
    for (const fragment of all) {
      total += fragment.tokens;
      segments[fragment.segment] += fragment.tokens;
      if (fragment.pinned) pinnedTokens += fragment.tokens;
    }
    const stats: ContextBuildStats = {
      totalTokens: Math.max(1, total),
      segments,
      pinnedTokens,
      buildMs: performance.now() - startedAt,
      incremental,
    };
    ContextManager.viewCaches.set(this.sessionRoot, { sourceIds, ledgerKey, selectionKey, header, fragments });
    // 返回逐块克隆，调用方（扩展 transform 等）可自由修改而不污染缓存模板。
    const view = all.map((fragment) => ({ ...fragment.message, content: fragment.message.content.map((block) => ({ ...block })) }));
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
      ledger.cacheBreakpoints = [...new Set(messageIds)].slice(-3);
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
      for (const message of eligible) {
        // pin 的消息不被驱逐；pin 占用超预算时由构建统计如实上报，不在这里悄悄绕过。
        if (pinnedIds?.has(message.id)) continue;
        const existing = entriesByMessage.get(message.id);
        if (existing) {
          if (existing.pinnedUntilRound >= ledger.round) continue;
          existing.state = "evicted";
          delete existing.restoredAt;
          continue;
        }
        const result = message.content.find((block) => block.type === "tool_result");
        if (!result || result.type !== "tool_result") continue;
        const artifactId = `artifact-${randomUUID()}`;
        await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
        await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
        const entry: LedgerEntry = { messageId: message.id, kind: "tool_result", artifactId, state: "evicted", createdRound: ledger.round, pinnedUntilRound: 0 };
        ledger.entries.push(entry);
        entriesByMessage.set(entry.messageId, entry);
      }
      await this.save(ledger);
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
