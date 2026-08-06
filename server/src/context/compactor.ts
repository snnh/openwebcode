import path from "node:path";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import { appendMemory, parseSedimentSections } from "../memory.js";
import type { FastModelClient } from "../fast-model.js";
import type { HookRunner } from "../hooks.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { UsageLog } from "../usage-log.js";
import { ContextManager, type CompactionRecord } from "./context-manager.js";

export interface CompactResult {
  changed: boolean;
  mode: CompactionRecord["mode"];
  uptoIndex?: number;
  summary?: string;
  reason?: string;
}

export const COMPACT_TOOLCALLS_SYSTEM = `你是上下文压缩器。把对话中的工具调用逐条压缩为一行语义占位符。
格式：- [工具] 名称(关键参数) → 结果要点（退出码/关键数字/错误原因）
规则：用户消息也各压一行（- [用户] 要点）；assistant 的结论文本各压一行（- [助手] 要点）。
只输出这些行，不要任何额外解释。保留 artifact: 引用不变。`;

export const COMPACT_OVERVIEW_SYSTEM = `你是上下文压缩器。把对话中段压缩为结构化概览，严格按以下小节输出：
目标：
行动：
修改文件：
关键发现：
未决事项：
用户明确指令：
每个小节用 "- " 列表逐条列出。「用户明确指令」小节：先完整保留输入中给出的已有指令（逐字），再追加新发现的指令（去重）。只输出概览本身。`;

/** 从快速模型的 overview 输出中解析「用户明确指令」小节（- 列表行）。 */
export function extractInstructions(text: string): string[] {
  const collected: string[] = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/用户明确指令/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      collected.push(item[1]!.trim());
      continue;
    }
    if (line.trim() === "" && collected.length === 0) continue;
    break;
  }
  return collected;
}

function mergeInstructions(previous: string[], extracted: string[]): string[] {
  const seen = new Set(previous);
  const merged = [...previous];
  for (const item of extracted) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  // 累积置顶也要有界：只留最近 20 条
  return merged.slice(-20);
}

function renderBlock(block: MessageContent): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return `[思考] ${block.text.slice(0, 200)}`;
  if (block.type === "tool_call") return `[调用工具 ${block.name}] ${JSON.stringify(block.input).slice(0, 300)}`;
  if (block.type === "tool_result") return `[工具结果${block.isError ? "（错误）" : ""}] ${block.content.slice(0, 800)}`;
  return "";
}

/** 渲染待压缩区段为纯文本转录，超长时保头留尾。 */
export function renderSpan(span: ChatMessage[], budget = 30_000): string {
  const transcript = span
    .map((message) => `【${message.role}】\n${message.content.map(renderBlock).filter(Boolean).join("\n")}`)
    .join("\n\n");
  if (transcript.length <= budget) return transcript;
  const head = Math.floor(budget * 0.4);
  const tail = budget - head;
  return `${transcript.slice(0, head)}\n\n…[中段 ${transcript.length - budget} 字符省略]…\n\n${transcript.slice(-tail)}`;
}

/** 无快速模型时的规则压缩：每个工具调用/用户消息压一行。 */
function ruleBasedToolcalls(span: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of span) {
    for (const block of message.content) {
      if (block.type === "tool_call") lines.push(`- [工具] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
      else if (block.type === "tool_result") lines.push(`  → ${block.isError ? "错误" : "完成"}：${block.content.slice(0, 120).replace(/\s+/g, " ")}`);
      else if (block.type === "text" && message.role === "user") lines.push(`- [用户] ${block.text.slice(0, 120).replace(/\s+/g, " ")}`);
    }
  }
  const body = lines.join("\n").slice(0, 4_000);
  return `[规则压缩] 早前 ${span.length} 条消息要点：\n${body || "（无要点）"}`;
}

/**
 * 上下文压缩器（plan §7.4）：
 * - toolcalls：占位摘要精炼（快速模型）；未配置时规则降级
 * - overview：结构化概览（快速模型），用户明确指令跨段累积置顶；
 *   未配置且非强制 → 报错提示；85% 强制 → 规则硬截断兜底（mode=truncated）
 * - 保留最近 keepTail 条消息不压缩；强制时 pinned 豁免失效（安全优先）
 */
export class Compactor {
  constructor(
    private readonly sessions: SessionStore,
    private readonly fastModel: FastModelClient,
    private readonly deps: { usageLog?: UsageLog; pricing?: PricingCatalog; exchangeRates?: ExchangeRateService; hooks?: HookRunner } = {},
    private readonly keepTail = 10,
  ) {}

  async compact(sessionId: string, mode: "toolcalls" | "overview", options: { forced?: boolean; promptOverrides?: { overview?: string; toolcalls?: string } } = {}): Promise<CompactResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const context = new ContextManager(this.sessions.contextRoot(sessionId));
    const ledger = await context.load();
    // 区段边界一律按活动路径计算：ContextManager.buildView 也是把 uptoIndex 应用到
    // activePathMessages 的结果上；用 messages.jsonl 全量（含分叉/编辑重发的废弃分支）
    // 会在有分支时索引错位——摘要混入废弃分支，keepTail 保护的最近消息被裁掉。
    // 注意：存量会话 ledger 里可能存着按全量长度算的旧 uptoIndex（>= 活动路径长度），
    // 方向保守（少压缩、不丢上下文），不做迁移。
    const activeMessages = activePathMessages(session.messages, session.activeLeafId);
    const compactedUpto = Math.min(ledger.compacted?.uptoIndex ?? 0, activeMessages.length);
    const clearedUpto = Math.min(ledger.cleared?.uptoIndex ?? 0, activeMessages.length);
    const previousUpto = Math.max(compactedUpto, clearedUpto);
    const uptoIndex = Math.max(previousUpto, activeMessages.length - this.keepTail);
    if (uptoIndex <= previousUpto) {
      return { changed: false, mode, reason: `没有新的可压缩区段（保留最近 ${this.keepTail} 条消息）` };
    }
    const span = activeMessages.slice(previousUpto, uptoIndex);
    const forced = options.forced === true;
    // PreCompact 钩子：exit 2 阻断本次压缩（Pre* 类阻断语义，同 PreToolUse）
    if (this.deps.hooks) {
      const outcome = await this.deps.hooks.run("PreCompact", { sessionId, cwd: session.cwd, compact: { strategy: mode, forced } });
      if (outcome.blocked) return { changed: false, mode, reason: outcome.reason ?? "压缩被 hook 阻断" };
    }
    let finalMode: CompactionRecord["mode"] = mode;
    let summary: string;
    let instructions = !ledger.cleared || compactedUpto > clearedUpto ? (ledger.compacted?.instructions ?? []) : [];

    if (this.fastModel.configured) {
      const transcript = renderSpan(span);
      // 提示词覆盖（prompt-overrides 面 / env-sim persona，由调用方按优先级组装）：
      // 压缩行为仍由 Node 强制（保留尾部、指令累积、降级链），覆盖只改模型侧文本。
      const system = mode === "overview"
        ? (options.promptOverrides?.overview ?? COMPACT_OVERVIEW_SYSTEM)
        : (options.promptOverrides?.toolcalls ?? COMPACT_TOOLCALLS_SYSTEM);
      const completion = await this.fastModel.complete({
        system,
        prompt: mode === "overview" && instructions.length > 0
          ? `已有的用户明确指令（逐字保留并置顶）：\n${instructions.map((item) => `- ${item}`).join("\n")}\n\n待压缩对话：\n${transcript}`
          : `待压缩对话：\n${transcript}`,
        maxTokens: 2048,
      });
      summary = completion.text.trim();
      if (mode === "overview") instructions = mergeInstructions(instructions, extractInstructions(summary));
      this.recordFastModelUsage(sessionId, completion.usage);
    } else {
      if (mode === "overview" && !forced) {
        throw new Error("快速模型未配置：概览压缩不可用。请在设置中配置快速模型，或使用 /compact tools（规则版）。");
      }
      summary = ruleBasedToolcalls(span);
      finalMode = mode === "overview" ? "truncated" : "toolcalls";
    }

    await context.updateLedger((current) => {
      // 85% 强制时 pin 失效（安全优先，§7.3-W）
      if (forced) {
        for (const entry of current.entries) entry.pinnedUntilRound = 0;
      }
      current.compacted = { uptoIndex, mode: finalMode, summary, instructions, createdAt: new Date().toISOString() };
    });
    // 长期记忆沉淀（§7.5）：overview 摘要的「关键发现/未决事项」落进项目 memory.md。
    // 单点落在此：85% 强制压缩（agent-runner）、REST 与 /compact 命令（app.ts runCompact）
    // 全部经 Compactor.compact；去重交给 appendMemory，失败只告警不影响压缩结果。
    // 注意按 finalMode 判断：快速模型缺失降级 truncated 时规则摘要不含结构化小节，
    // 若按请求 mode 判断会把工具参数里的「关键发现」字样误收进记忆
    if (finalMode === "overview") {
      try {
        const facts = parseSedimentSections(summary);
        if (facts.length > 0) await appendMemory(path.join(session.cwd, ".owc", "memory.md"), facts);
      } catch (error) {
        process.stderr.write(`[memory] 沉淀失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    // PostCompact 钩子：仅通知不阻断（含降级后的 finalMode 与 uptoIndex）
    if (this.deps.hooks) {
      await this.deps.hooks.run("PostCompact", { sessionId, cwd: session.cwd, compact: { strategy: mode, forced, changed: true, finalMode, uptoIndex } });
    }
    return { changed: true, mode: finalMode, uptoIndex, summary };
  }

  /** Fast-model usage is attributed to the selected real provider/model. */
  private recordFastModelUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number }): void {
    if (!this.deps.usageLog) return;
    const provider = this.fastModel.provider ?? "unknown";
    const model = this.fastModel.model ?? "unknown";
    const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: 0, cacheWrite: 0 };
    const cost = calculateUsageCost(tokens, this.deps.pricing?.get(provider, model), this.deps.exchangeRates?.current());
    void this.deps.usageLog.record({
      at: new Date().toISOString(),
      sessionId,
      provider,
      model,
      ...tokens,
      priced: cost.priced,
      ...(cost.usd ? { usdMicroUnits: cost.usd.microUnits.toString() } : {}),
      ...(cost.cny ? { cnyMicroUnits: cost.cny.microUnits.toString() } : {}),
    }).catch((error: unknown) => {
      process.stderr.write(`[usage-log] 写入失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}
