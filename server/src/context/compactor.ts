import type { ExchangeRateService } from "../cost/exchange-rate.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { Provider2Client } from "../provider2.js";
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

const TOOLCALLS_SYSTEM = `你是上下文压缩器。把对话中的工具调用逐条压缩为一行语义占位符。
格式：- [工具] 名称(关键参数) → 结果要点（退出码/关键数字/错误原因）
规则：用户消息也各压一行（- [用户] 要点）；assistant 的结论文本各压一行（- [助手] 要点）。
只输出这些行，不要任何额外解释。保留 artifact: 引用不变。`;

const OVERVIEW_SYSTEM = `你是上下文压缩器。把对话中段压缩为结构化概览，严格按以下小节输出：
目标：
行动：
修改文件：
关键发现：
未决事项：
用户明确指令：
每个小节用 "- " 列表逐条列出。「用户明确指令」小节：先完整保留输入中给出的已有指令（逐字），再追加新发现的指令（去重）。只输出概览本身。`;

/** 从 provider2 的 overview 输出中解析「用户明确指令」小节（- 列表行）。 */
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

/** 无 provider2 时的规则压缩：每个工具调用/用户消息压一行。 */
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
 * - toolcalls：占位摘要精炼（provider2）；未配置时规则降级
 * - overview：结构化概览（provider2），用户明确指令跨段累积置顶；
 *   未配置且非强制 → 报错提示；85% 强制 → 规则硬截断兜底（mode=truncated）
 * - 保留最近 keepTail 条消息不压缩；强制时 pinned 豁免失效（安全优先）
 */
export class Compactor {
  constructor(
    private readonly sessions: SessionStore,
    private readonly provider2: Provider2Client,
    private readonly deps: { usageLog?: UsageLog; pricing?: PricingCatalog; exchangeRates?: ExchangeRateService } = {},
    private readonly keepTail = 10,
  ) {}

  async compact(sessionId: string, mode: "toolcalls" | "overview", options: { forced?: boolean } = {}): Promise<CompactResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const context = new ContextManager(this.sessions.contextRoot(sessionId));
    const ledger = await context.load();
    const previousUpto = Math.min(ledger.compacted?.uptoIndex ?? 0, session.messages.length);
    const uptoIndex = Math.max(previousUpto, session.messages.length - this.keepTail);
    if (uptoIndex <= previousUpto) {
      return { changed: false, mode, reason: `没有新的可压缩区段（保留最近 ${this.keepTail} 条消息）` };
    }
    const span = session.messages.slice(previousUpto, uptoIndex);
    const forced = options.forced === true;
    let finalMode: CompactionRecord["mode"] = mode;
    let summary: string;
    let instructions = ledger.compacted?.instructions ?? [];

    if (this.provider2.configured) {
      const transcript = renderSpan(span);
      const completion = await this.provider2.complete({
        system: mode === "overview" ? OVERVIEW_SYSTEM : TOOLCALLS_SYSTEM,
        prompt: mode === "overview" && instructions.length > 0
          ? `已有的用户明确指令（逐字保留并置顶）：\n${instructions.map((item) => `- ${item}`).join("\n")}\n\n待压缩对话：\n${transcript}`
          : `待压缩对话：\n${transcript}`,
        maxTokens: 2048,
      });
      summary = completion.text.trim();
      if (mode === "overview") instructions = mergeInstructions(instructions, extractInstructions(summary));
      this.recordProvider2Usage(sessionId, completion.usage);
    } else {
      if (mode === "overview" && !forced) {
        throw new Error("provider2 未配置：概览压缩不可用。请在设置中配置 provider2，或使用 /compact tools（规则版）。");
      }
      summary = ruleBasedToolcalls(span);
      finalMode = mode === "overview" ? "truncated" : "toolcalls";
    }

    // 85% 强制时 pin 失效（安全优先，§7.3-W）
    if (forced) {
      for (const entry of ledger.entries) entry.pinnedUntilRound = 0;
    }
    ledger.compacted = { uptoIndex, mode: finalMode, summary, instructions, createdAt: new Date().toISOString() };
    await context.save(ledger);
    return { changed: true, mode: finalMode, uptoIndex, summary };
  }

  /** provider2 用量进全局报表（provider="provider2" 分项；定价目录无此模型则计为未定价）。 */
  private recordProvider2Usage(sessionId: string, usage: { inputTokens: number; outputTokens: number }): void {
    if (!this.deps.usageLog) return;
    const model = this.provider2.model ?? "unknown";
    const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: 0, cacheWrite: 0 };
    const cost = calculateUsageCost(tokens, this.deps.pricing?.get("provider2", model), this.deps.exchangeRates?.current());
    void this.deps.usageLog.record({
      at: new Date().toISOString(),
      sessionId,
      provider: "provider2",
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
