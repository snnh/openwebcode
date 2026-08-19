import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { FastModelClient } from "../fast-model.js";
import type { HookRunner } from "../hooks.js";
import { appendMemory, parseSedimentSections } from "../memory.js";
import { ContextManager, estimateFragmentTokens, recordCompaction } from "../context/context-manager.js";
import { extractInstructions, mergeInstructions, type CompactResult } from "../context/compactor.js";
import { withTimeout } from "../http-utils.js";
import type { ProviderRegistry } from "../providers/provider.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { UsageLog } from "../usage-log.js";

/** 目录条目：key 是主模型召回的记忆标识，files 指向 compact/segments/ 下的真实内容文件。 */
interface VaultSection {
  key: string;
  title: string;
  files: string[];
  desc: string;
}

interface VaultChunkFile {
  file: string;
  firstMessageId: string;
  lastMessageId: string;
  messages: number;
}

/** compact/index.json 结构：sections/chunkFiles 跨次压缩累积（key 全局唯一），uptoIndex 单调递增。 */
interface VaultIndex {
  version: 1;
  uptoIndex: number;
  createdAt: string;
  sections: VaultSection[];
  chunkFiles: VaultChunkFile[];
}

/** 快速模型 Pass 1：把一块对话转录整理为目录条目（KEY/TITLE/FILES/DESC 四行 + --- 分隔）。 */
const VAULT_ORGANIZE_SYSTEM = `你是上下文档案整理器。输入是一段代码助手对话转录（分块）。请把这块转录中仍相关的内容整理为目录条目：
- 每条目四行字段，顺序固定：
  KEY: <小写英文短标识，如 goals/impl/issues，不得与已给 key 重复>
  TITLE: <简短标题>
  FILES: <所属转录文件名>
  DESC: <一句话描述本条目的内容>
- 条目之间用 --- 分隔。
- 过时内容（已被后续修改取代的决策、已完成的临时操作、无关闲聊）不要列成条目。
- 工具调用细节不要单独列条目，只提炼它们体现的事实与结论。
- 只输出条目，不要任何额外解释。`;

/** 快速模型 Pass 2：合并/去重/删除过时条目，输出目录式索引（发给主模型的摘要）。 */
const VAULT_INDEX_SYSTEM = `你是上下文档案库的目录编辑。输入是本次压缩整理出的目录条目与历史归档条目。请：
1. 合并语义重复的条目，删除过时条目（已被取代的决策、已完成且不再需要的步骤）。
2. 输出最终目录索引，目录式结构，尽量短，主模型据此选择性召回：
[归档索引] 早前共 N 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。
- <标题> (key=<key>)：<一句话>
每行一个条目，key 必须与输入完全一致。
3. 若存在必须继续遵守的用户明确指令，在最后以「用户明确指令：」开头，其后每行一条「- <指令>」（逐字保留）。
只输出索引本身，不要任何额外解释。`;

/** 渲染单条消息为纯文本转录（与 compactor 的 renderBlock 同构，但无截断——归档要完整真实内容）。 */
function renderBlock(block: MessageContent): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return `[思考] ${block.text}`;
  if (block.type === "tool_call") return `[调用工具 ${block.name}] ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return `[工具结果${block.isError ? "（错误）" : ""}] ${block.content}`;
  return "";
}

/** 归档分块：按 chunkSize 切消息序列。 */
export function chunkMessages(messages: ChatMessage[], chunkSize: number): ChatMessage[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: ChatMessage[][] = [];
  for (let index = 0; index < messages.length; index += size) {
    chunks.push(messages.slice(index, index + size));
  }
  return chunks;
}

/** 渲染一块消息为归档文件正文（含文件头，保留全部内容）。 */
export function renderChunk(chunk: ChatMessage[], file: string): string {
  const header = [
    `# 归档转录 ${file}`,
    `消息数：${chunk.length}；范围：${chunk[0]?.id ?? ""} … ${chunk[chunk.length - 1]?.id ?? ""}`,
    "",
  ].join("\n");
  const body = chunk
    .map((message) => `【${message.role}】\n${message.content.map(renderBlock).filter(Boolean).join("\n")}`)
    .join("\n\n");
  return `${header}${body}\n`;
}

/**
 * 解析快速模型 Pass 1 输出的目录条目（容错：KEY:/TITLE:/FILES:/DESC: 四行字段，--- 分隔）。
 * 不完整条目丢弃；FILES 缺失时由调用方按当前块文件补齐。
 */
export function parseSectionList(text: string): Array<{ key: string; title: string; files?: string; desc: string }> {
  const result: Array<{ key: string; title: string; files?: string; desc: string }> = [];
  let current: Partial<{ key: string; title: string; files: string; desc: string }> = {};
  let sawKey = false;
  const flush = (): void => {
    if (sawKey && current.key && current.title) {
      result.push({
        key: current.key,
        title: current.title,
        ...(current.files ? { files: current.files } : {}),
        desc: current.desc ?? "",
      });
    }
    current = {};
    sawKey = false;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---" || line.startsWith("```")) {
      if (line === "---") flush();
      continue;
    }
    const keyMatch = /^KEY:\s*(.+)$/i.exec(line);
    if (keyMatch) {
      flush();
      sawKey = true;
      current.key = keyMatch[1]!.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
      continue;
    }
    if (!sawKey) continue;
    const titleMatch = /^TITLE:\s*(.+)$/i.exec(line);
    const filesMatch = /^FILES:\s*(.+)$/i.exec(line);
    const descMatch = /^DESC:\s*(.+)$/i.exec(line);
    if (titleMatch) current.title = titleMatch[1]!.trim().slice(0, 120);
    else if (filesMatch) current.files = filesMatch[1]!.trim().slice(0, 200);
    else if (descMatch) current.desc = descMatch[1]!.trim().slice(0, 300);
  }
  flush();
  return result;
}

/** 读取 compact/index.json；缺失或形状不合法返回 null（不抛错——recall 与回注都按无归档降级）。 */
export async function loadVaultIndex(compactDir: string): Promise<VaultIndex | null> {
  try {
    const value = JSON.parse(await readFile(path.join(compactDir, "index.json"), "utf8")) as Partial<VaultIndex>;
    const uptoIndex = value.uptoIndex;
    if (value.version !== 1 || typeof uptoIndex !== "number" || !Number.isSafeInteger(uptoIndex) || uptoIndex < 0 ||
        typeof value.createdAt !== "string" || !Array.isArray(value.sections) || !Array.isArray(value.chunkFiles)) {
      return null;
    }
    const sections = value.sections
      .filter((section): section is VaultSection => Boolean(section) && typeof section.key === "string" && typeof section.title === "string")
      .map((section) => ({ key: section.key, title: section.title, files: Array.isArray(section.files) ? section.files.filter((file): file is string => typeof file === "string") : [], desc: typeof section.desc === "string" ? section.desc : "" }));
    const chunkFiles = value.chunkFiles
      .filter((file): file is VaultChunkFile => Boolean(file) && typeof file.file === "string")
      .map((file) => ({ file: file.file, firstMessageId: String(file.firstMessageId ?? ""), lastMessageId: String(file.lastMessageId ?? ""), messages: Number.isSafeInteger(file.messages) ? file.messages : 0 }));
    return { version: 1, uptoIndex, createdAt: value.createdAt, sections, chunkFiles };
  } catch {
    return null;
  }
}

/**
 * 档案库压缩服务（compact-vault 官方扩展的 server 侧实现，模式同 ContentLensService）：
 * - compact()：把待压缩区段完整转录归档到 <contextRoot>/compact/segments/，快速模型两遍整理
 *   （Pass 1 逐块提取目录条目、Pass 2 合并去重删除过时并生成目录式索引），索引写入
 *   ledger.compacted（mode=vault）注入主模型视图；
 * - readFile()：供扩展 API context.readVaultFile 使用（只读、路径锁定在 compact/ 内）；
 * - 召回（recall_memory 工具）由 Extension Host 侧实现：index.json → 片段 → 快速模型提炼。
 */
export class CompactVaultService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly fastModel: FastModelClient,
    private readonly providers: ProviderRegistry,
    private readonly deps: {
      usageLog?: UsageLog; pricing?: PricingCatalog; exchangeRates?: ExchangeRateService; hooks?: HookRunner;
      /** 延迟读取 compact-vault 扩展配置（装配早于 ExtensionManager 时闭包后取）。 */
      getConfig?: () => Record<string, unknown>;
    } = {},
  ) {}

  async compact(sessionId: string, options: { keepTail?: number; chunkSize?: number; maxTokens?: number } = {}): Promise<CompactResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const context = new ContextManager(this.sessions.contextRoot(sessionId));
    const ledger = await context.load();
    // 区段边界与 Compactor 同纪律：按活动路径计算（含分叉时索引不错位）
    const activeMessages = activePathMessages(session.messages, session.activeLeafId);
    const compactedUpto = Math.min(ledger.compacted?.uptoIndex ?? 0, activeMessages.length);
    const clearedUpto = Math.min(ledger.cleared?.uptoIndex ?? 0, activeMessages.length);
    const previousUpto = Math.max(compactedUpto, clearedUpto);
    const keepTail = Math.max(0, Math.floor(options.keepTail ?? 10));
    const uptoIndex = Math.max(previousUpto, activeMessages.length - keepTail);
    if (uptoIndex <= previousUpto) {
      return { changed: false, mode: "vault", reason: `没有新的可压缩区段（保留最近 ${keepTail} 条消息）` };
    }
    // PreCompact 钩子：exit 2 阻断本次压缩（与 Compactor 同语义）
    if (this.deps.hooks) {
      const outcome = await this.deps.hooks.run("PreCompact", { sessionId, cwd: session.cwd, compact: { strategy: "overview", forced: false } });
      if (outcome.blocked) return { changed: false, mode: "vault", reason: outcome.reason ?? "压缩被 hook 阻断" };
    }
    if (!this.fastModel.configured) throw new Error("快速模型未配置：档案库压缩不可用。请在设置中配置快速模型后重试。");
    const span = activeMessages.slice(previousUpto, uptoIndex);
    const compactDir = path.join(this.sessions.contextRoot(sessionId), "compact");
    await mkdir(path.join(compactDir, "segments"), { recursive: true });
    const previous = await loadVaultIndex(compactDir);
    const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 25));
    const chunks = chunkMessages(span, chunkSize);
    // 归档：真实内容落盘（seg 序号全局递增，跨次压缩不覆盖旧文件）
    const chunkFiles: VaultChunkFile[] = [];
    const nextSeq = (previous?.chunkFiles.length ?? 0) + 1;
    for (const [index, chunk] of chunks.entries()) {
      const file = `segments/seg-${String(nextSeq + index).padStart(3, "0")}.md`;
      await writeFile(path.join(compactDir, file), renderChunk(chunk, file), "utf8");
      chunkFiles.push({ file, firstMessageId: chunk[0]!.id, lastMessageId: chunk[chunk.length - 1]!.id, messages: chunk.length });
    }
    // Pass 1：逐块提取目录条目（跨块与跨次去重 key）
    const sections: VaultSection[] = [];
    const knownKeys = new Set(previous?.sections.map((section) => section.key) ?? []);
    const maxTokens = this.resolveMaxTokens(options.maxTokens);
    for (const [index, chunk] of chunks.entries()) {
      const completion = await this.completeVault(VAULT_ORGANIZE_SYSTEM, buildOrganizePrompt(chunk, chunkFiles[index]!, sections, index + 1, chunks.length), maxTokens);
      this.recordFastModelUsage(sessionId, completion.usage);
      for (const parsed of parseSectionList(completion.text)) {
        if (knownKeys.has(parsed.key)) continue;
        knownKeys.add(parsed.key);
        sections.push({
          key: parsed.key,
          title: parsed.title,
          files: parsed.files ? splitFileList(parsed.files) : [chunkFiles[index]!.file],
          desc: parsed.desc,
        });
      }
    }
    // Pass 2：合并去重/删除过时 + 生成目录式索引（主模型摘要）；用户明确指令跨段累积置顶
    const instructions = !ledger.cleared || compactedUpto > clearedUpto ? (ledger.compacted?.instructions ?? []) : [];
    const merge = await this.completeVault(VAULT_INDEX_SYSTEM, buildIndexPrompt(span.length, sections, previous?.sections ?? [], instructions), maxTokens);
    this.recordFastModelUsage(sessionId, merge.usage);
    const indexText = merge.text.trim();
    const mergedInstructions = mergeInstructions(instructions, extractInstructions(indexText));
    // 写 index.json（跨次累积：历史 section 仍可召回）
    const vaultIndex: VaultIndex = {
      version: 1,
      uptoIndex,
      createdAt: new Date().toISOString(),
      sections: [...(previous?.sections ?? []), ...sections],
      chunkFiles: [...(previous?.chunkFiles ?? []), ...chunkFiles],
    };
    await writeFile(path.join(compactDir, "index.json"), `${JSON.stringify(vaultIndex, null, 2)}\n`, "utf8");
    const record = {
      uptoIndex,
      mode: "vault" as const,
      summary: indexText,
      instructions: mergedInstructions,
      createdAt: new Date().toISOString(),
      // 与 Compactor 同口径：被替换消息段的 token 估算，供 UI 检查点行展示
      replacedTokens: span.reduce((total, message) => total + estimateFragmentTokens(message), 0),
    };
    await context.updateLedger((current) => {
      recordCompaction(current, record);
    });
    // 长期记忆沉淀（与 Compactor 同纪律）：目录索引的「未决事项」等小节落进项目 memory.md
    try {
      const facts = parseSedimentSections(indexText);
      if (facts.length > 0) await appendMemory(path.join(session.cwd, ".owc", "memory.md"), facts);
    } catch (error) {
      process.stderr.write(`[memory] 沉淀失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (this.deps.hooks) {
      await this.deps.hooks.run("PostCompact", { sessionId, cwd: session.cwd, compact: { strategy: "overview", forced: false, changed: true, finalMode: "vault", uptoIndex } });
    }
    return { changed: true, mode: "vault", uptoIndex, summary: indexText, createdAt: record.createdAt };
  }

  /**
   * 整理补全（思考模型优先适配）：优先走 FastModelClient 现有链路（重试/thinking 配置齐全）；
   * 思考型快速模型的正文可能全部落在 thinking 通道（或思考耗尽输出上限），FastModelClient 抛
   * 「快速模型返回为空」时，用 providers 直连（与 chat 发送消息同一条 streamChat 通路）收集
   * text_delta 优先、thinking_delta/thinking_end 兜底，不再报错。
   */
  private async completeVault(system: string, prompt: string, maxTokens: number | undefined): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    // 有上限时优先走 FastModelClient 现有链路（重试/thinking 配置齐全）；
    // 思考型快速模型正文可能全部落在思考通道（或思考耗尽上限），FastModelClient 抛
    // 「快速模型返回为空」时与无上限场景一起走直连兜底。
    if (maxTokens !== undefined) {
      try {
        return await this.fastModel.complete({ system, prompt, maxTokens });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("快速模型返回为空")) throw error;
      }
    }
    // 直连（同一 provider.streamChat 发送链路）：text_delta 优先、thinking_delta/thinking_end 兜底
    const provider = this.providers.get(this.fastModel.provider ?? "");
    if (!provider) throw new Error(`快速模型服务商不可用：${this.fastModel.provider}`);
    let text = "";
    let thinking = "";
    for await (const event of provider.streamChat({
      model: this.fastModel.model ?? "",
      system,
      messages: [{
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        createdAt: new Date().toISOString(),
      }],
      tools: [],
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: withTimeout(undefined, 120_000),
    })) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "thinking_delta") thinking += event.text;
      else if (event.type === "thinking_end" && thinking === "") thinking = event.text;
      else if (event.type === "done" && (event.stopReason === "refusal" || event.stopReason === "error")) {
        throw new Error(`模型停止原因：${event.stopReason}`);
      }
    }
    const finalText = text.trim() !== "" ? text : thinking.trim();
    if (finalText === "") throw new Error("快速模型返回为空");
    return { text: finalText, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  /** 整理输出上限：显式 options 优先，否则读扩展配置（缺省不限制——端点默认）。 */
  private resolveMaxTokens(option: number | undefined): number | undefined {
    if (option !== undefined && Number.isSafeInteger(option) && option > 0) return option;
    const configured = this.deps.getConfig?.()?.maxTokens;
    if (typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0) return configured;
    return undefined;
  }

  /** 读取 compact/ 内文件（扩展 API context.readVaultFile 的服务端实现）。 */
  async readFile(sessionId: string, relative: string): Promise<string | null> {
    if (!(await this.sessions.get(sessionId))) throw new Error("Session not found");
    const target = this.vaultPath(sessionId, relative);
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      return await readFile(target, "utf8");
    } catch {
      return null;
    }
  }

  /** 相对路径解析：禁绝对路径、禁 .. 逃逸（含 Windows 盘符/UNC），必须落在 compact/ 内。 */
  private vaultPath(sessionId: string, relative: string): string {
    if (!relative || path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) {
      throw new Error("vault file path must be a non-empty relative path");
    }
    const root = path.join(this.sessions.contextRoot(sessionId), "compact");
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("vault file path escapes the compact directory");
    return resolved;
  }

  /** Fast-model usage 计入所选真实 provider/model（与 Compactor 同记账纪律）。 */
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

function splitFileList(value: string): string[] {
  return value.split(/[,，\s]+/).map((file) => file.trim()).filter((file) => file !== "");
}

/** Pass 1 提示词：块转录 + 已提取条目（跨块/跨次去重）。 */
function buildOrganizePrompt(chunk: ChatMessage[], chunkFile: VaultChunkFile, sections: VaultSection[], chunkIndex: number, chunkTotal: number): string {
  const existing = sections.length > 0
    ? `\n已提取的目录条目（KEY 不得与这些重复）：\n${sections.map((section) => `- key=${section.key}：${section.title}`).join("\n")}\n`
    : "";
  return `待整理对话块（第 ${chunkIndex}/${chunkTotal} 块），转录文件：${chunkFile.file}${existing}\n\n对话转录：\n${renderChunk(chunk, chunkFile.file)}`;
}

/** Pass 2 提示词：全部条目（新 + 历史）与用户明确指令（逐字保留）。 */
function buildIndexPrompt(messageCount: number, sections: VaultSection[], previous: VaultSection[], instructions: string[]): string {
  const all = [...previous, ...sections];
  const entryLines = all.length > 0
    ? all.map((section) => `- key=${section.key}：${section.title} — ${section.desc}（${section.files.join(", ")}）`).join("\n")
    : "- （本次整理未提取到条目）";
  const instructionBlock = instructions.length > 0
    ? `\n\n必须继续遵守的用户明确指令（逐字保留在输出中）：\n${instructions.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `待压缩对话共 ${messageCount} 条消息。目录条目（新条目 + 历史归档条目，key 必须与输入一致）：\n${entryLines}${instructionBlock}`;
}
