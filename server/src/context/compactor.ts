import path from "node:path";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import { appendMemory, parseSedimentSections } from "../memory.js";
import { monotonicTimestamp } from "../monotonic-clock.js";
import type { FastModelClient } from "../fast-model.js";
import type { HookRunner } from "../hooks.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { UsageLog } from "../usage-log.js";
import { ContextManager, compactionIndexIn, estimateFragmentTokens, recordCompaction, type CompactionRecord } from "./context-manager.js";

export interface CompactResult {
  changed: boolean;
  mode: CompactionRecord["mode"];
  uptoIndex?: number;
  summary?: string;
  /** 账本记录的创建时间（changed 时存在）：事件载荷与 UI 检查点行 key 复用同一值。 */
  createdAt?: string;
  reason?: string;
}

export const COMPACT_TOOLCALLS_SYSTEM = `你是上下文压缩器。把对话中的工具调用逐条压缩为一行语义占位符。
格式：- [工具] 名称(关键参数) → 结果要点（退出码/关键数字/错误原因）
示例：- [工具] read_file(src/index.ts) → 成功，导出 IndexStore 类
规则：用户消息也各压一行（- [用户] 要点）；assistant 的结论文本各压一行（- [助手] 要点）。
若输入含「既有摘要」（更早一次压缩的产出，其覆盖的对话不在下文中）：先把它的要点保留在输出开头（可精炼，但关键结论不得丢失），再接本次新压缩的行。
只输出这些行，不要任何额外解释。保留 artifact: 引用不变。
禁止逐字复述对话原文；输出必须显著短于输入。`;

export const COMPACT_OVERVIEW_SYSTEM = `你是上下文压缩器。把对话中段压缩为结构化概览，严格按以下小节输出：
目标：
行动：
修改文件：
关键发现：
未决事项：
用户明确指令：
每个小节用 "- " 列表逐条列出，每节 1–6 条。「用户明确指令」小节：先完整保留输入中给出的已有指令（逐字），再追加新发现的指令（去重）。
若输入含「既有摘要」（更早一次压缩的产出，其覆盖的对话不在下文中）：把它承接进对应小节——目标/关键发现/未决事项中的既有要点不得丢失，与本次新内容合并为一份完整概览。
只输出概览本身。
禁止逐字复述对话原文；输出必须显著短于输入。`;

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

/** 指令跨段累积（去重、保留顺序、只留最近 20 条）。 */
export function mergeInstructions(previous: string[], extracted: string[]): string[] {
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

/**
 * 压缩输出校验：返回失败原因（undefined 表示通过）。
 * 模型偶尔会把待压缩对话原文原样返回（或返回思考内容），此类输出既没瘦身、
 * 又会因 uptoIndex 前进而永久失去重新压缩的机会，写入账本前必须拦截。
 */
export function validateCompactionOutput(mode: "toolcalls" | "overview", summary: string, transcriptLength: number): string | undefined {
  // 复述原文：转录由 renderSpan 用【role】标记拼接，输出若带角色标记即逐字复述
  if (/【(user|assistant|system|tool)】/.test(summary)) {
    return "输出复述了对话原文（含转录角色标记）";
  }
  if (mode === "overview") {
    // 概览模式：6 个小节至少命中 3 个，否则未按格式
    const sections = ["目标", "行动", "修改文件", "关键发现", "未决事项", "用户明确指令"];
    if (sections.filter((name) => summary.includes(name)).length < 3) {
      return "输出未按概览格式（应含目标/行动/修改文件/关键发现/未决事项/用户明确指令小节）";
    }
  } else {
    // toolcalls 模式：非空行至少半数匹配占位行格式（- [工具] …）
    const lines = summary.split("\n").filter((line) => line.trim() !== "");
    const placeholderCount = lines.filter((line) => /^\s*[-*]\s*\[/.test(line)).length;
    if (lines.length === 0 || placeholderCount < lines.length / 2) {
      return "输出未按工具占位格式（每行应为 - [工具] 名称(关键参数) → 结果要点）";
    }
  }
  // 长度兜底：转录足够长时摘要仍接近原文长度视为未压缩（比率放得很宽，只为拦极端情况）
  if (transcriptLength >= 4000 && summary.length > transcriptLength * 0.8) {
    return "输出过长（接近原文长度），未压缩成功";
  }
  return undefined;
}

function renderBlock(block: MessageContent): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return `[思考] ${block.text.slice(0, 200)}`;
  if (block.type === "tool_call") return `[调用工具 ${block.name}] ${JSON.stringify(block.input).slice(0, 300)}`;
  if (block.type === "tool_result") return `[工具结果${block.isError ? "（错误）" : ""}] ${block.content.slice(0, 800)}`;
  if (block.type === "web_search_call") return "[联网搜索]";
  return "";
}

/** 渲染待压缩区段为纯文本转录，超长时保头留尾。 */
function renderSpan(span: ChatMessage[], budget = 30_000): string {
  const transcript = span
    .map((message) => `【${message.role}】\n${message.content.map(renderBlock).filter(Boolean).join("\n")}`)
    .join("\n\n");
  if (transcript.length <= budget) return transcript;
  const head = Math.floor(budget * 0.4);
  const tail = budget - head;
  return `${transcript.slice(0, head)}\n\n…[中段 ${transcript.length - budget} 字符省略]…\n\n${transcript.slice(-tail)}`;
}

/** 无快速模型时的规则压缩：每个工具调用/用户消息压一行；既有摘要（上一次压缩）截段置顶承接，避免二次压缩丢失首段结论。 */
function ruleBasedToolcalls(span: ChatMessage[], previousSummary?: string): string {
  const lines: string[] = [];
  for (const message of span) {
    for (const block of message.content) {
      if (block.type === "tool_call") lines.push(`- [工具] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
      else if (block.type === "tool_result") lines.push(`  → ${block.isError ? "错误" : "完成"}：${block.content.slice(0, 120).replace(/\s+/g, " ")}`);
      else if (block.type === "text" && message.role === "user") lines.push(`- [用户] ${block.text.slice(0, 120).replace(/\s+/g, " ")}`);
    }
  }
  const body = lines.join("\n").slice(0, 4_000);
  // 规则路径没有模型归并能力，既有摘要按原文截段承接（上限防跨次膨胀）
  const previousSection = previousSummary ? `既有摘要（早前压缩）：\n${previousSummary.slice(0, 2_000)}\n` : "";
  return `[规则压缩] 早前 ${span.length} 条消息要点：\n${previousSection}${body || "（无要点）"}`;
}

/**
 * 压缩边界对齐工具调用批次：返回不超过 uptoIndex 的最大边界，保证 [0, boundary) 前缀
 * 不截断任何工具批次——assistant 的 tool_call 落在前缀内时，其全部 tool_result 也必须
 * 落在前缀内（否则压缩后视图留下孤儿 tool_result，被 provider 配对修复静默丢弃）。
 * 结果恒在调用之后（append-only 转录），倒扫一遍即可：命中跨界批次就把边界收到该调用之前，
 * 收缩后继续向下检查（级联收缩）。无对应结果的调用（中断轮残留）不算跨界——它本就无配对，
 * 压缩掉不制造新孤儿。
 */
export function alignCompactionBoundary(messages: ChatMessage[], uptoIndex: number): number {
  let boundary = Math.min(Math.max(0, uptoIndex), messages.length);
  const resultIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    for (const block of messages[index]!.content) {
      if (block.type === "tool_result") resultIndex.set(block.toolCallId, index);
    }
  }
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool_call") continue;
      const result = resultIndex.get(block.id);
      if (result !== undefined && result >= boundary) {
        boundary = index;
        break;
      }
    }
  }
  return boundary;
}

/**
 * 上下文压缩器（plan §7.4）：
 * - toolcalls：占位摘要精炼（快速模型）；未配置时规则降级
 * - overview：结构化概览（快速模型），用户明确指令跨段累积置顶；
 *   未配置且非强制 → 报错提示；85% 强制 → 规则硬截断兜底（mode=truncated）
 * - 保留最近 keepTail 条消息不压缩；强制时 pinned 豁免失效（安全优先）
 * - 二次压缩把上一次摘要作为「既有摘要」承接（模型归并 / 规则截段置顶），首段结论不丢
 * - 边界双重保护：protectFromMessageId（本轮触发消息及其之后不压缩）+ 工具批次对齐
 *   （alignCompactionBoundary，区段不截断 tool_call/tool_result 配对）；
 *   记录以 uptoMessageId 锚定边界（分叉离路径时视图不裁剪，见 compactionIndexIn）
 */
export class Compactor {
  constructor(
    private readonly sessions: SessionStore,
    private readonly fastModel: FastModelClient,
    private readonly deps: { usageLog?: UsageLog; pricing?: PricingCatalog; exchangeRates?: ExchangeRateService; hooks?: HookRunner } = {},
    private readonly keepTail = 10,
  ) {}

  /** 压缩时快速模型的输出上限（tokens）取值函数：默认 65536，setCompactMaxTokens 注入后走设置热生效值。 */
  private compactMaxTokens: () => number = () => 65_536;

  /** 注入压缩输出上限的实时取值函数（index.ts 装配：settings.effective().compactMaxTokens）。 */
  setCompactMaxTokens(get: () => number): void {
    this.compactMaxTokens = get;
  }

  async compact(sessionId: string, mode: "toolcalls" | "overview", options: { forced?: boolean; promptOverrides?: { overview?: string; toolcalls?: string }; protectFromMessageId?: string } = {}): Promise<CompactResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const context = new ContextManager(this.sessions.contextRoot(sessionId));
    const ledger = await context.load();
    // 区段边界一律按活动路径计算：ContextManager.buildView 也是把 uptoIndex 应用到
    // activePathMessages 的结果上；用 messages.jsonl 全量（含分叉/编辑重发的废弃分支）
    // 会在有分支时索引错位——摘要混入废弃分支，keepTail 保护的最近消息被裁掉。
    // 边界优先按 uptoMessageId 锚定（与 buildView 同函数）：用户在旧边界之下分叉时
    // 边界消息离路径，compactedUpto 归 0（旧摘要覆盖的消息回到视图，从新区段重新压缩，
    // 且不再把旧摘要当「既有摘要」承接——它所描述的内容此刻可见，无需合并）。
    // 旧记录无 id 时回退 uptoIndex 下标语义；存量账本里可能存着按全量长度算的旧 uptoIndex
    //（>= 活动路径长度），方向保守（少压缩、不丢上下文），不做迁移。
    const activeMessages = activePathMessages(session.messages, session.activeLeafId);
    const compactedUpto = ledger.compacted ? compactionIndexIn(activeMessages, ledger.compacted) : 0;
    const clearedUpto = Math.min(ledger.cleared?.uptoIndex ?? 0, activeMessages.length);
    const previousUpto = Math.max(compactedUpto, clearedUpto);
    let uptoIndex = Math.max(previousUpto, activeMessages.length - this.keepTail);
    // 本轮触发消息保护（agent 主循环强制压缩）：触发消息及其之后的内容绝不进压缩区段——
    // 触发消息是本轮工作的出发点，被压缩掉会让模型失去当前任务目标。
    if (options.protectFromMessageId !== undefined) {
      const protectIndex = activeMessages.findIndex((message) => message.id === options.protectFromMessageId);
      if (protectIndex >= 0) uptoIndex = Math.min(uptoIndex, protectIndex);
    }
    // 对齐工具调用批次：区段不得截断 tool_call/tool_result 配对（孤儿结果会被
    // provider 配对修复静默丢弃，等于无损信道里丢信息）。
    uptoIndex = alignCompactionBoundary(activeMessages, uptoIndex);
    if (uptoIndex <= previousUpto) {
      return { changed: false, mode, reason: `没有新的可压缩区段（保留最近 ${this.keepTail} 条消息，且触发消息与工具批次边界受保护）` };
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
    // 既有摘要承接（二次压缩不丢首段结论）：仅当旧压缩边界仍是视图有效边界时承接——
    // 旧边界被 /clear 覆盖或分叉离路径时，其摘要内容已不在视图/或对应消息已回到视图，不再合并。
    const previousSummary = ledger.compacted && compactedUpto > 0 && compactedUpto > clearedUpto
      ? ledger.compacted.summary
      : undefined;

    if (this.fastModel.configured) {
      const transcript = renderSpan(span);
      // 提示词覆盖（prompt-overrides 面 / env-sim persona，由调用方按优先级组装）：
      // 压缩行为仍由 Node 强制（保留尾部、指令累积、降级链），覆盖只改模型侧文本。
      const system = mode === "overview"
        ? (options.promptOverrides?.overview ?? COMPACT_OVERVIEW_SYSTEM)
        : (options.promptOverrides?.toolcalls ?? COMPACT_TOOLCALLS_SYSTEM);
      // 用户提示词尾部提醒：利用近因效应对抗复述（只输出压缩结果，不逐字复述原文）
      const tailReminder = "\n\n再次提醒：只输出压缩结果，不要复述上面的对话原文。";
      // 既有摘要段：放在最前（位置靠前、语义上是更早的对话），模型按其要求合并承接
      const previousSection = previousSummary !== undefined
        ? `既有摘要（更早一次压缩的产出，其覆盖的对话不在下文转录中）：\n${previousSummary}\n\n`
        : "";
      const userPrompt = mode === "overview" && instructions.length > 0
        ? `${previousSection}已有的用户明确指令（逐字保留并置顶）：\n${instructions.map((item) => `- ${item}`).join("\n")}\n\n待压缩对话：\n${transcript}${tailReminder}`
        : `${previousSection}待压缩对话：\n${transcript}${tailReminder}`;
      // 长度校验的输入基线包含既有摘要：合并承接后的输出合法地长于本次转录
      const inputLength = transcript.length + previousSection.length;
      try {
        const first = await this.fastModel.complete({
          system,
          prompt: userPrompt,
          maxTokens: this.compactMaxTokens(),
        });
        this.recordFastModelUsage(sessionId, first.usage);
        let reason = validateCompactionOutput(mode, first.text.trim(), inputLength);
        let completion = first;
        if (reason !== undefined) {
          // 校验失败重试一次：把失败原因拼进 system 追加纠偏指令，重调一次 complete
          const retried = await this.fastModel.complete({
            system: `${system}\n\n上次输出不合格：${reason}。必须严格按格式压缩，禁止逐字复述对话原文。`,
            prompt: userPrompt,
            maxTokens: this.compactMaxTokens(),
          });
          this.recordFastModelUsage(sessionId, retried.usage);
          reason = validateCompactionOutput(mode, retried.text.trim(), inputLength);
          completion = retried;
        }
        if (reason !== undefined) {
          // 第二次仍失败：抛错由下方 catch 统一处理——forced → 规则降级兜底；
          // 非 forced → 原样抛出（手动 /compact 让用户知情，账本不写入）
          throw new Error(`快速模型压缩输出未通过校验（${reason}）。请重试，或使用 /compact tools（规则版）。`);
        }
        summary = completion.text.trim();
        if (mode === "overview") instructions = mergeInstructions(instructions, extractInstructions(summary));
      } catch (error) {
        // 快速模型调用失败或输出两次未过校验：85% 强制压缩时规则降级兜底（安全网不失效，
        // 压缩照常完成）；手动 /compact 维持抛错让用户知情。finalMode 约定与未配置快速模型的
        // 降级分支一致，记忆沉淀按 finalMode 判断，规则摘要（无结构化小节）不会误入 memory.md。
        if (!forced) throw error;
        summary = ruleBasedToolcalls(span, previousSummary);
        finalMode = mode === "overview" ? "truncated" : "toolcalls";
      }
    } else {
      if (mode === "overview" && !forced) {
        throw new Error("快速模型未配置：概览压缩不可用。请在设置中配置快速模型，或使用 /compact tools（规则版）。");
      }
      summary = ruleBasedToolcalls(span, previousSummary);
      finalMode = mode === "overview" ? "truncated" : "toolcalls";
    }

    const record: CompactionRecord = {
      uptoIndex,
      // 边界锚点（F5）：buildView 按 id 定位，分叉离路径时不靠下标误伤新分支
      uptoMessageId: activeMessages[uptoIndex - 1]!.id,
      mode: finalMode,
      summary,
      instructions,
      createdAt: monotonicTimestamp(),
      // 被替换消息段的 token 估算（与视图归因同一估算器），供 UI 检查点行展示
      replacedTokens: span.reduce((total, message) => total + estimateFragmentTokens(message), 0),
    };
    await context.updateLedger((current) => {
      // 85% 强制时 pin 失效（安全优先，§7.3-W）
      if (forced) {
        for (const entry of current.entries) entry.pinnedUntilRound = 0;
      }
      recordCompaction(current, record);
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
    return { changed: true, mode: finalMode, uptoIndex, summary, createdAt: record.createdAt };
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
