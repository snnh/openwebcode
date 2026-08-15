/**
 * context-saver 官方扩展的服务端实现：滚动驱逐（自动/手动）、上下文条目管理
 *（恢复/固定/再逐出）与驱逐策略更新。核心（context/）只保留账本存储原语、
 * 视图组装、预算与压缩；本模块的全部能力随扩展开关启停——扩展关闭时路由 409、
 * agent 循环跳过自动驱逐（强制压缩是核心安全网，不受扩展开关影响）。
 * 依赖方向：本模块 → context 核心；核心不得反向依赖本模块。
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../../sessions/types.js";
import { estimateTokens } from "../../context/model-profile.js";
import type { ContextManager } from "../../context/context-manager.js";
import type { ContextLedger, ContextPolicy, LedgerEntry, TurnLedger } from "../../context/context-types.js";

/** 驱逐策略更新 DTO（入参校验在 updateEvictionPolicy）。 */
export type ContextPolicyUpdate = Partial<Pick<ContextPolicy, "enabled" | "strategy" | "evictionMode" | "lag" | "interval" | "minRetainTokens" | "readKeepLines" | "pinExemptRounds" | "restoreBudget">>;

/** read_file 结果行数不超过该值时始终保留（与 token 下限并列的独立豁免：10 行是完整的文件结构认知）。 */
export const READ_ALWAYS_RETAIN_LINES = 10;
/** read 头尾摘录的总字符上限：minified 长行文件兜住，超出仍走 artifact。 */
const READ_EXCERPT_MAX_CHARS = 8000;
/**
 * 永不驱逐的工具结果白名单：这些工具的结果是后续轮次的关键上下文（如图片描述），
 * 驱逐会破坏任务连续性。自动驱逐与手动驱逐都跳过。
 */
export const EVICTION_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["ext__vision-tools__describe_image"]);

/**
 * 按轮计算保留集：一轮 = 一批连续的 tool 消息（对应一次 assistant tool_call 批次的全部结果）。
 * 保留最近 max(lag, 1) 轮——活动路径以 tool 批次结尾时该批是当轮（模型尚未看到），始终保护；
 * 路径以非 tool 消息结尾时严格保留最近 lag 轮。
 */
export function retainedToolIds(messages: ChatMessage[], lag: number): ReadonlySet<string> {
  const retained = new Set<string>();
  const endsWithToolBatch = messages.length > 0 && messages[messages.length - 1]!.role === "tool";
  const keepRounds = Math.max(lag, endsWithToolBatch ? 1 : 0);
  let rounds = 0;
  let index = messages.length - 1;
  while (index >= 0 && rounds < keepRounds) {
    if (messages[index]!.role !== "tool") {
      index -= 1;
      continue;
    }
    rounds += 1;
    while (index >= 0 && messages[index]!.role === "tool") {
      retained.add(messages[index]!.id);
      index -= 1;
    }
  }
  return retained;
}

/** toolCallId → 工具名（来自 assistant 消息的 tool_call 块），供驱逐条目记录语义摘要。 */
export function toolNameByCallId(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_call") names.set(block.id, block.name);
    }
  }
  return names;
}

/** read_file 被逐时的头尾摘录：头/尾各 keepLines 行 + 中间省略注记；总字符超上限时砍头部保尾部。 */
export function buildReadExcerpt(content: string, keepLines: number, artifactId: string): string {
  const lines = content.split("\n");
  if (lines.length <= keepLines * 2 + 1) return content;
  const head = lines.slice(0, keepLines);
  const tail = lines.slice(-keepLines);
  const omission = `[... ${lines.length - keepLines * 2} lines elided; artifact:${artifactId}; call read_artifact with artifactId "${artifactId}", offset and limit to re-read a slice ...]`;
  let excerpt = [...head, omission, ...tail].join("\n");
  if (excerpt.length > READ_EXCERPT_MAX_CHARS) {
    const budget = Math.max(0, READ_EXCERPT_MAX_CHARS - (omission.length + tail.join("\n").length + 64));
    excerpt = `${head.join("\n").slice(0, budget)}\n[... head truncated ...]\n${omission}\n${tail.join("\n")}`;
  }
  return excerpt;
}

/** 驱逐判定与执行：就地改 ledger 并写 artifact 文件；返回是否产生账本变更。 */
async function applyEviction(root: string, ledger: ContextLedger, messages: ChatMessage[], pinnedIds?: ReadonlySet<string>): Promise<boolean> {
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
      await mkdir(path.join(root, "artifacts"), { recursive: true });
      artifactsDirReady = true;
    }
    await writeFile(path.join(root, "artifacts", `${artifactId}.txt`), result.content, "utf8");
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

/**
 * 自动驱逐（agent 主循环每轮调用；仅在 context-saver 扩展启用时调用）。
 * 轮级句柄路径：驱逐延迟到 commitTurn 在最终账本（含并发外部变更）上判定执行；
 * 空跑不落盘的优化保留（按 applyEviction 返回值决定是否写盘）。
 * 返回值是工作副本（尚未应用驱逐），最终条目以 commitTurn 返回为准。
 */
export async function evictContext(context: ContextManager, root: string, messages: ChatMessage[], pinnedIds?: ReadonlySet<string>, turn?: TurnLedger): Promise<ContextLedger> {
  if (turn) {
    turn.pending.push({ apply: (ledger) => applyEviction(root, ledger, messages, pinnedIds), appliedToWorking: false });
    return turn.working;
  }
  return context.transactLedger(async (ledger) => applyEviction(root, ledger, messages, pinnedIds));
}

/** 手动逐出单条工具结果（面板条目操作）。 */
export async function evictMessage(context: ContextManager, root: string, messages: ChatMessage[], messageId: string): Promise<ContextLedger> {
  const message = messages.find((item) => item.id === messageId && item.role === "tool");
  if (!message) throw new Error("Tool result message not found");
  const result = message.content.find((block) => block.type === "tool_result");
  if (!result || result.type !== "tool_result") throw new Error("Message has no tool result");
  const toolName = toolNameByCallId(messages).get(result.toolCallId);
  if (toolName !== undefined && EVICTION_EXEMPT_TOOLS.has(toolName)) {
    throw new Error(`Tool result of ${toolName} is exempt from eviction`);
  }
  return context.transactLedger(async (ledger) => {
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
      await mkdir(path.join(root, "artifacts"), { recursive: true });
      await writeFile(path.join(root, "artifacts", `${artifactId}.txt`), result.content, "utf8");
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
  });
}

/** 固定/取消固定条目（pin 的条目不被自动驱逐）。 */
export async function setContextEntryPinned(context: ContextManager, messageId: string, pinned: boolean): Promise<ContextLedger> {
  return context.transactLedger(async (ledger) => {
    const entry = ledger.entries.find((candidate) => candidate.messageId === messageId);
    if (!entry) throw new Error("Context entry not found");
    entry.pinnedUntilRound = pinned ? Number.MAX_SAFE_INTEGER : 0;
  });
}

/** 恢复被逐出的条目：回写保护轮数 + restoreBudget 总量约束（超额从最早回写项提前解 pin）。 */
export async function restoreContextEntry(context: ContextManager, root: string, messageId: string): Promise<ContextLedger> {
  return context.transactLedger(async (ledger) => {
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
      const bytes = await stat(path.join(root, "artifacts", `${candidate.artifactId}.txt`)).then((value) => value.size).catch(() => 0);
      const tokens = Math.ceil(bytes / 4);
      sizes.set(candidate.messageId, tokens);
      estimatedTokens += tokens;
    }
    for (const candidate of restored) {
      if (estimatedTokens <= ledger.policy.restoreBudget) break;
      candidate.pinnedUntilRound = 0;
      estimatedTokens -= sizes.get(candidate.messageId) ?? 0;
    }
  });
}

/** 驱逐策略更新（含入参校验）；预算字段（maxSessionTokens/maxSessionCost）走核心 updateBudget，不在此列。 */
export async function updateEvictionPolicy(context: ContextManager, update: ContextPolicyUpdate): Promise<ContextLedger> {
  return context.transactLedger(async (ledger) => {
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
  });
}
