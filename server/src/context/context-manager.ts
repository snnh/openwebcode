/**
 * 上下文管理器：账本持久化、驱逐、压缩、视图构建与增量缓存。
 * 类型定义在 ./context-types.ts，纯函数/常量在 ./context-ledger-ops.ts（本文件重导出对外 API）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";
import type { ChatMessage } from "../sessions/types.js";
import { estimateTokens, type Currency } from "./model-profile.js";
import type {
  BudgetUpdate,
  ContextLedger,
  ContextPolicyUpdate,
  ContextSelection,
  ContextSegmentBreakdown,
  ContextBuildStats,
  ContextView,
  BuildViewOptions,
  ViewFragment,
  ViewBuildCache,
  LedgerCacheEntry,
  TurnLedger,
  LedgerEntry,
  RecordedCost,
} from "./context-types.js";
import {
  READ_ALWAYS_RETAIN_LINES,
  EVICTION_EXEMPT_TOOLS,
  computeLedgerKey,
  retainedToolIds,
  toolNameByCallId,
  buildReadExcerpt,
  buildFragment,
  applyProcessEviction,
  normalizeLedger,
  aggregateEvicted,
  applyUsage,
  clearIndexIn,
  renderCompaction,
  enforceImageBudget,
  estimateFragmentTokens,
} from "./context-ledger-ops.js";

const MAX_CACHED_LEDGERS = 32;
const MAX_CACHED_VIEWS = 32;

export class ContextManager {
  private static readonly operations = new Map<string, Promise<void>>();
  private static readonly viewCaches = new Map<string, ViewBuildCache>();
  private static readonly ledgerCaches = new Map<string, LedgerCacheEntry>();

  constructor(private readonly sessionRoot: string) {}

  /** 读取账本。命中缓存时返回规范副本本身——调用方必须只读；突变请走各变更方法。 */
  async load(): Promise<ContextLedger> {
    return (await this.loadLedger()).ledger;
  }

  /**
   * 读取 ledger + 预算好的 buildView 缓存键。磁盘事实只在指纹（size/mtime/ctime）
   * 变化时重读；命中返回缓存持有的规范副本本身（只读约定，不再逐次克隆），
   * save 仍是唯一提交点。
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
        return { ledger: cached.ledger, ledgerKey: cached.ledgerKey };
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
    return { ledger, ledgerKey: entry.ledgerKey };
  }

  /** 突变路径专用：规范副本的深克隆，改完经 save 提交（自载自存的既有纪律）。 */
  private async loadMutable(): Promise<ContextLedger> {
    return structuredClone((await this.loadLedger()).ledger);
  }

  async save(ledger: ContextLedger): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    const target = path.join(this.sessionRoot, "ledger.json");
    // 紧凑序列化：ledger.json 只被机器读取（面板经 REST 拿结构化数据）；
    // 读取侧 JSON.parse 天然兼容存量美化格式。
    await writeUtf8Atomically(target, `${JSON.stringify(ledger)}\n`);
    // 落盘即提交点：重 stat 更新缓存主本。调用方让渡 ledger 所有权——主本直接持有
    // 该对象（省一次全量克隆），落盘后再原地改它会污染缓存（全部调用方均 save 后即只读）。
    const info = await stat(target);
    ContextManager.touchLedgerCache(this.sessionRoot, {
      ledger,
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

  async buildView(messages: ChatMessage[], options?: BuildViewOptions, turn?: TurnLedger): Promise<ContextView> {
    const startedAt = performance.now();
    let ledger: ContextLedger;
    let ledgerKey: string;
    if (turn) {
      // 轮级句柄：复用 beginTurn 的工作副本，不再逐方法重读；轮内 key 相关字段不变。
      ledger = turn.working;
      ledgerKey = turn.ledgerKey ??= computeLedgerKey(ledger);
    } else {
      ({ ledger, ledgerKey } = await this.loadLedger());
    }
    const selection: ContextSelection = { pins: options?.selection?.pins ?? [], excludes: options?.selection?.excludes ?? [] };
    const pinnedIds = new Set(selection.pins);
    const compacted = ledger.compacted;
    const compactedIndex = compacted ? Math.min(compacted.uptoIndex, messages.length) : 0;
    // 清空边界优先按消息 id 锚定：buildView 的输入数组既可能是活动路径（agent 主循环）
    // 也可能是全量 JSONL（REST context 视图），id 定位自动适配两个空间；边界消息不在
    // 数组中（罕见：消息被外部截断）或旧 ledger 无 id 时回退 uptoIndex 下标语义。
    const clearedIndex = ledger.cleared ? clearIndexIn(messages, ledger.cleared) : 0;
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
    const evicted = aggregateEvicted(ledger.entries);
    const stats: ContextBuildStats = {
      totalTokens: Math.max(1, total),
      segments: segments!,
      pinnedTokens,
      buildMs: performance.now() - startedAt,
      incremental,
      ...(evicted ? { evicted } : {}),
    };
    ContextManager.touchViewCache(this.sessionRoot, {
      sourceIds: sourceIds!, ledgerKey, selectionKey, header, fragments,
      totalTokens: total, segments: { ...segments! }, pinnedTokens, view: master!,
    });
    // 返回按消息/内容数组浅拷：调用方（扩展 transform 等）可替换消息或内容数组而不污染
    // 缓存主本；内容块按不可变数据共享（现有调用方均为整体替换或 IPC 序列化，无原地改写）。
    const view = master!.map((message) => ({ ...message, content: [...message.content] }));
    if (ledger.policy.evictionMode !== "process") return { messages: view, ledger, stats };
    // 超级节省：结构后处理（整轮过程出视图）在缓存主本之外应用，产出确定；结构变化后
    // 按最终视图重算 token 归因，保证 85% 水位依据的是真实注入量。
    const processed = applyProcessEviction(view, ledger, pinnedIds);
    if (processed === view) return { messages: view, ledger, stats };
    const processedSegments: ContextSegmentBreakdown = { system: 0, compactionSummary: 0, toolResults: 0, messages: 0, repoMap: 0, other: 0 };
    let processedTotal = 0;
    let processedPinned = 0;
    for (const message of processed) {
      const tokens = estimateFragmentTokens(message);
      processedTotal += tokens;
      processedSegments[message.role === "tool" ? "toolResults" : message.id.startsWith("compaction:") ? "compactionSummary" : "messages"] += tokens;
      if (pinnedIds.has(message.id)) processedPinned += tokens;
    }
    return {
      messages: processed,
      ledger,
      stats: { ...stats, totalTokens: Math.max(1, processedTotal), segments: processedSegments, pinnedTokens: processedPinned },
    };
  }

  async budgetStatus(turn?: TurnLedger): Promise<{
    token: { limit?: number; used: number; paused: boolean };
    cost: { limit?: { currency: Currency; microUnits: string }; usedMicroUnits: string; paused: boolean; reason?: "cost_exhausted" | "cost_unavailable" };
    paused: boolean;
  }> {
    const ledger = turn ? turn.working : await this.load();
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
      const ledger = await this.loadMutable();
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
      const ledger = await this.loadMutable();
      if (update.enabled !== undefined) {
        if (typeof update.enabled !== "boolean") throw new Error("enabled must be a boolean");
        ledger.policy.enabled = update.enabled;
      }
      if (update.strategy !== undefined) {
        if (!["lag", "interval", "off"].includes(update.strategy)) throw new Error("strategy must be lag, interval, or off");
        ledger.policy.strategy = update.strategy;
      }
      if (update.evictionMode !== undefined) {
        if (!["placeholder", "process"].includes(update.evictionMode)) throw new Error("evictionMode must be placeholder or process");
        ledger.policy.evictionMode = update.evictionMode;
      }
      for (const key of ["lag", "interval", "minRetainTokens", "readKeepLines", "pinExemptRounds", "restoreBudget"] as const) {
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
    turn?: TurnLedger,
  ): Promise<ContextLedger> {
    if (turn) {
      // 轮级句柄：即时应用到工作副本（事件载荷需要本轮最新成本），commitTurn 统一落盘；
      // 增量语义天然可交换，rebase 重放不丢并发的子代理/REST 记账。
      applyUsage(turn.working, usage, cost);
      turn.pending.push({ apply: (ledger) => { applyUsage(ledger, usage, cost); }, appliedToWorking: true });
      turn.mustSave = true;
      return turn.working;
    }
    return this.serial(async () => {
      const ledger = await this.loadMutable();
      applyUsage(ledger, usage, cost);
      await this.save(ledger);
      return ledger;
    });
  }

  async updateLedger(update: (ledger: ContextLedger) => void): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.loadMutable();
      update(ledger);
      await this.save(ledger);
      return ledger;
    });
  }

  async markCleared(uptoIndex: number, uptoMessageId?: string): Promise<ContextLedger> {
    if (!Number.isSafeInteger(uptoIndex) || uptoIndex < 0) throw new Error("Clear index must be a non-negative integer");
    return this.updateLedger((ledger) => {
      ledger.cleared = { uptoIndex, at: new Date().toISOString(), ...(uptoMessageId ? { uptoMessageId } : {}) };
    });
  }

  async replaceLedger(value: unknown): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = normalizeLedger(value && typeof value === "object" ? value as Partial<ContextLedger> : {});
      await this.save(ledger);
      return ledger;
    });
  }

  async recordCacheBreakpoints(messageIds: string[], turn?: TurnLedger): Promise<ContextLedger> {
    if (turn) {
      const next = [...new Set(messageIds)].slice(-3);
      const current = turn.working.cacheBreakpoints;
      // 内容未变时既不改副本也不落盘（热路径每轮都调用，多数轮断点不变）。
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return turn.working;
      }
      turn.working.cacheBreakpoints = next;
      turn.pending.push({ apply: (ledger) => { ledger.cacheBreakpoints = next; }, appliedToWorking: true });
      turn.mustSave = true;
      return turn.working;
    }
    return this.serial(async () => {
      const ledger = await this.loadMutable();
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

  async advanceRound(turn?: TurnLedger): Promise<ContextLedger> {
    if (turn) {
      turn.working.round += 1;
      turn.pending.push({ apply: (ledger) => { ledger.round += 1; }, appliedToWorking: true });
      turn.mustSave = true;
      return turn.working;
    }
    return this.serial(async () => {
      const ledger = await this.loadMutable();
      ledger.round += 1;
      await this.save(ledger);
      return ledger;
    });
  }

  /**
   * 轮级共享句柄：一轮一次深克隆（替代过去每方法一次），本轮各方法经句柄读写工作副本，
   * commitTurn 统一落盘。与并发的外部变更（REST pin/恢复、子代理记账）安全共存：
   * commit 检测到落盘事实已前进时把本轮变更重放到最新账本。
   */
  async beginTurn(): Promise<TurnLedger> {
    return this.serial(async () => {
      const { ledger } = await this.loadLedger();
      return {
        working: structuredClone(ledger),
        source: ContextManager.ledgerCaches.get(this.sessionRoot),
        pending: [],
        mustSave: false,
        ledgerKey: undefined,
      };
    });
  }

  /**
   * 句柄落盘：fast path（期间无外部落盘，缓存主本条目引用不变）直接在工作副本上补应用
   * 驱逐类变更；否则把本轮全部变更重放到最新账本（增量类可交换，驱逐按最新条目判定），
   * 两侧变更都不丢。有变更才落盘——recordCacheBreakpoints 多数轮跳过、evict 空跑跳过的
   * 既有优化均保留。幂等：pending 为空直接返回（finally 兜底重复提交安全）。
   */
  async commitTurn(turn: TurnLedger): Promise<ContextLedger> {
    if (turn.pending.length === 0) return turn.working;
    return this.serial(async () => {
      let base: ContextLedger;
      let pending = turn.pending;
      const cached = ContextManager.ledgerCaches.get(this.sessionRoot);
      if (cached !== undefined && cached === turn.source) {
        base = turn.working;
        pending = pending.filter((mutation) => !mutation.appliedToWorking);
      } else {
        base = structuredClone((await this.loadLedger()).ledger);
      }
      let mutated = turn.mustSave;
      for (const mutation of pending) {
        if ((await mutation.apply(base)) === true) mutated = true;
      }
      if (mutated) await this.save(base);
      turn.working = base;
      turn.pending = [];
      turn.mustSave = false;
      turn.source = ContextManager.ledgerCaches.get(this.sessionRoot);
      turn.ledgerKey = undefined;
      return base;
    });
  }

  async evict(messages: ChatMessage[], pinnedIds?: ReadonlySet<string>, turn?: TurnLedger): Promise<ContextLedger> {
    if (turn) {
      // 轮级句柄：驱逐延迟到 commitTurn 在最终账本（含并发外部变更）上判定执行；
      // 空跑不落盘的优化保留（按 applyEviction 返回值决定是否写盘）。
      // 返回值是工作副本（尚未应用驱逐），最终条目以 commitTurn 返回为准。
      turn.pending.push({ apply: (ledger) => this.applyEviction(ledger, messages, pinnedIds), appliedToWorking: false });
      return turn.working;
    }
    return this.serial(async () => {
      const ledger = await this.loadMutable();
      // 无新增/状态变化时跳过落盘（lag 窗口内多数轮 eligible 为空或已全部驱逐）。
      if (await this.applyEviction(ledger, messages, pinnedIds)) await this.save(ledger);
      return ledger;
    });
  }

  /** 驱逐判定与执行：就地改 ledger 并写 artifact 文件；返回是否产生账本变更。 */
  private async applyEviction(ledger: ContextLedger, messages: ChatMessage[], pinnedIds?: ReadonlySet<string>): Promise<boolean> {
    const toolMessages = messages.filter((message) => message.role === "tool");
    if (!ledger.policy.enabled || ledger.policy.strategy === "off") return false;
    // lag 按轮计（一轮 = 一批连续 tool 消息，即一次 assistant tool_call 批次的全部结果）；
    // 当轮（尾部批次）始终保护，保证任何结果至少在紧随其后的模型调用中完整出现一次。
    const retained = retainedToolIds(messages, ledger.policy.lag);
    const eligible = ledger.policy.strategy === "lag"
      ? toolMessages.filter((message) => !retained.has(message.id))
      : ledger.policy.strategy === "interval" && ledger.round % Math.max(1, ledger.policy.interval) === 0
        ? toolMessages.filter((message) => !retained.has(message.id))
        : [];
    const toolNames = toolNameByCallId(messages);
    // Ledger entries grow with the session. Index them once so eviction stays
    // linear in the newly eligible tool messages instead of O(T×E).
    const entriesByMessage = new Map(ledger.entries.map((entry) => [entry.messageId, entry]));
    // artifacts 目录 mkdir 每轮最多一次（原来每条被驱逐消息一次 recursive mkdir）。
    let artifactsDirReady = false;
    let mutated = false;
    for (const message of eligible) {
      // pin 的消息不被驱逐；pin 占用超预算时由构建统计如实上报，不在这里悄悄绕过。
      if (pinnedIds?.has(message.id)) continue;
      const result = message.content.find((block) => block.type === "tool_result");
      if (!result || result.type !== "tool_result") continue;
      const toolName = toolNames.get(result.toolCallId);
      // 白名单工具（如图片描述）结果永不驱逐——丢失会破坏后续轮次的关键上下文
      if (toolName !== undefined && EVICTION_EXEMPT_TOOLS.has(toolName)) continue;
      const existing = entriesByMessage.get(message.id);
      if (existing) {
        if (existing.pinnedUntilRound >= ledger.round) continue;
        if (existing.state !== "evicted" || existing.restoredAt !== undefined) {
          existing.state = "evicted";
          delete existing.restoredAt;
          // 旧账本条目可能缺 evictedTokens（恢复后重新驱逐）：按当前内容补烧
          if (existing.evictedTokens === undefined) {
            const current = message.content.find((block) => block.type === "tool_result");
            if (current?.type === "tool_result") existing.evictedTokens = estimateTokens(current.content);
          }
          mutated = true;
        }
        continue;
      }
      const resultTokens = estimateTokens(result.content);
      // 豁免下限：小结果驱逐收益微乎其微，反而搅动缓存前缀；read ≤10 行是完整的文件结构认知
      if (resultTokens < ledger.policy.minRetainTokens) continue;
      if (toolName === "read_file" && result.content.split("\n").length <= READ_ALWAYS_RETAIN_LINES) continue;
      const artifactId = `artifact-${randomUUID()}`;
      if (!artifactsDirReady) {
        await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
        artifactsDirReady = true;
      }
      await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
      const entry: LedgerEntry = {
        messageId: message.id,
        kind: "tool_result",
        artifactId,
        state: "evicted",
        createdRound: ledger.round,
        pinnedUntilRound: 0,
        ...(toolName ? { toolName } : {}),
        sizeBytes: Buffer.byteLength(result.content, "utf8"),
        evictedTokens: resultTokens,
        ...(result.isError ? { isError: true } : {}),
        ...(toolName === "read_file" ? { excerpt: buildReadExcerpt(result.content, ledger.policy.readKeepLines, artifactId) } : {}),
      };
      ledger.entries.push(entry);
      entriesByMessage.set(entry.messageId, entry);
      mutated = true;
    }
    return mutated;
  }

  async evictMessage(messages: ChatMessage[], messageId: string): Promise<ContextLedger> {
    return this.serial(async () => {
      const message = messages.find((item) => item.id === messageId && item.role === "tool");
      if (!message) throw new Error("Tool result message not found");
      const result = message.content.find((block) => block.type === "tool_result");
      if (!result || result.type !== "tool_result") throw new Error("Message has no tool result");
      const toolName = toolNameByCallId(messages).get(result.toolCallId);
      if (toolName !== undefined && EVICTION_EXEMPT_TOOLS.has(toolName)) {
        throw new Error(`Tool result of ${toolName} is exempt from eviction`);
      }
      const ledger = await this.loadMutable();
      const existing = ledger.entries.find((entry) => entry.messageId === messageId);
      if (existing) {
        existing.state = "evicted";
        existing.pinnedUntilRound = 0;
        delete existing.restoredAt;
        // 重新驱逐已恢复条目：旧账本可能缺 evictedTokens，按当前内容补烧
        if (existing.evictedTokens === undefined) {
          const current = message.content.find((block) => block.type === "tool_result");
          if (current?.type === "tool_result") existing.evictedTokens = estimateTokens(current.content);
        }
      } else {
        const artifactId = `artifact-${randomUUID()}`;
        await mkdir(path.join(this.sessionRoot, "artifacts"), { recursive: true });
        await writeFile(path.join(this.sessionRoot, "artifacts", `${artifactId}.txt`), result.content, "utf8");
        ledger.entries.push({
          messageId,
          kind: "tool_result",
          artifactId,
          state: "evicted",
          createdRound: ledger.round,
          pinnedUntilRound: 0,
          ...(toolName ? { toolName } : {}),
          sizeBytes: Buffer.byteLength(result.content, "utf8"),
          evictedTokens: estimateTokens(result.content),
          ...(result.isError ? { isError: true } : {}),
          ...(toolName === "read_file" ? { excerpt: buildReadExcerpt(result.content, ledger.policy.readKeepLines, artifactId) } : {}),
        });
      }
      await this.save(ledger);
      return ledger;
    });
  }

  async setPinned(messageId: string, pinned: boolean): Promise<ContextLedger> {
    return this.serial(async () => {
      const ledger = await this.loadMutable();
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
      const ledger = await this.loadMutable();
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

// 对外 API：纯函数与类型经本文件重导出，既有 import 点不变。
export { estimateFragmentTokens };
export { isPathExcluded, recordCompaction, selectCacheBreakpoints } from "./context-ledger-ops.js";
export type { BudgetUpdate, ContextPolicyUpdate, TurnLedger, CompactionRecord } from "./context-types.js";
