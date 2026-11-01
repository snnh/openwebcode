/**
 * dsh-sync 扩展 M3a/M4a：dsh v3/v4 会话 → owc 会话的纯转换模块（无 IO、无 IPC）。
 *
 * 读形态覆盖两代（读支持 v3/v4；写出仍 v3，见 `dsh-sync-dsh.ts`）：
 * - v3：`tool/result` 是 `user` 角色 + `source:{kind:'tool',callId}` + 单元素
 *   `content:[{type:'tool-result',toolCallId,content:[...],isError?}]` 包装；
 * - v4：`tool/result` 是**一等 tool 角色**消息（`role:'tool'` + `message.toolCallId` +
 *   `content:[块...]` 直挂 + `message.isError`，无包装）；未知内容块类型被加 `plugin:` 前缀；
 *   另有 `permission/preset`、`sandbox/mode`、`subagent/descriptor`、`request/context`、
 *   与 `session-log-<name>/delivery-accepted` 等附加事件 —— 一律按未知事件丢弃 + 计数。
 *
 * M4a 增量：图片块可经注入的 attachment 解析器内联为 `image{mediaType,data}`（含 tool_result 内的
 * 图片进 `media[]`）；不注入解析器时行为与 M3a 完全一致（一律文本占位 + 计数）。
 *
 * 输入是 M1 发现层 `decodeDshSessionFile` 的产物 `{header, events}`；输出可直接喂
 * `serializeSession`（落 messages.jsonl）与 `ContextManager.replaceLedger`（落 ledger.json）。
 * 一切降级都不静默：丢进 `report.droppedEvents` / `report.warnings` / `report.counts`。
 *
 * 上游权威词汇（`.tmp/dsh-refs/` + `server/assets/dsh-web/plugins/.../typert.host.js` 里的
 * `SessionEventMap` 声明）：
 * - surface 四类事件（必带 `surfaceOp`）：`system/message`、`user/message`、`assistant/message`、`tool/result`；
 * - 内容块：`text{text}` / `reasoning{text}` / `image{attachment}` / `file{attachment}` /
 *   `tool-call{id,name,arguments}` / `tool-result{toolCallId,content,isError?}`；
 * - 压缩：`compaction/summary{summary,shadowedSeqs,shadowedRange}` 与 `compaction/prune{…}`；
 * - `request/header{header:{config:{provider,model,…}}}`、`session/title{title,messageSeqs,source}`；
 * - `reasoning` 的 `signature`/`redacted` **不在块上**，而在 assistant message 的
 *   `source.replayState.blocks[index]`（llm-service-lite 的回放元数据：anthropic-messages 写
 *   `signature`/`redacted`，openai-responses 把完整 reasoning item JSON 写 `item`）——三者都读，
 *   块上自带时优先用块上的。
 */
import type { CompactionRecord } from "../context/context-types.js";
import type {
  ChatMessage,
  ImageContent,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultContent,
} from "../sessions/types.js";
import { asRecord, isoOfMs } from "./json-utils.js";

/** dsh 的 surface 事件类型集合（决定"可见历史"的四类事件；v3/v4 同词表）。 */
const SURFACE_TYPES: readonly string[] = ["system/message", "user/message", "assistant/message", "tool/result"];

/**
 * 直接映射到 meta / 账本的事件类型：既不产生消息，也不进丢弃账（它们有 owc 产物）。
 * `compaction/prune` 刻意不在其中——本里程碑一律丢弃并计数（见 {@link convertDshSession}）。
 */
const META_EVENT_TYPES: readonly string[] = ["session/title", "request/header", "compaction/summary"];

/** 缺 id 时的确定性消息 id 前缀（`dsh-<seq>`：便于压缩锚点回查）。 */
const GENERATED_ID_PREFIX = "dsh-";

/** 标题截断长度。 */
const TITLE_MAX_LENGTH = 120;

/** 消息无 provider 归属时的 thinking.provider 兜底值。 */
const FALLBACK_PROVIDER = "dsh";

/** 事件缺失/非法时的 seq 占位（M1 已校验 seq 稠密，这里只是防御）。 */
const NO_SEQ = -1;

/** 转换统计（面板展示用）。 */
export interface ConversionCounts {
  /** 转换出的 user 消息数（含由孤儿 tool_result 降级来的 user 消息）。 */
  user: number;
  /** 转换出的 assistant 消息数。 */
  assistant: number;
  /** 转换出的 tool 消息数（降级成 user 的孤儿结果不计在这里）。 */
  tool: number;
  /** 遇到过的 image 内容块总数（含 tool_result 内的图片）。 */
  images: number;
  /** 其中读不出字节（无附件解析器 / 附件缺失）而降级为文本占位的数量。 */
  imagesMissing: number;
}

/** 一次会话转换的报告（面板展示 + 可复制）。 */
export interface ConversionReport {
  /** 被丢弃的事件类型 → 条数（按键名排序，稳定可复现）。 */
  droppedEvents: Record<string, number>;
  /** 人类可读的降级/丢失说明（处理顺序 + 末尾聚合，稳定可复现）。 */
  warnings: string[];
  /** 转换统计。 */
  counts: ConversionCounts;
}

/** 转换产物：meta 片段 + 可直接落盘的消息与账本。 */
export interface DshSessionConversion {
  meta: {
    title?: string;
    cwd?: string;
    /** ISO 时间串（header.createdAt 毫秒 → ISO）。 */
    createdAt: string;
    /** `request/header` 事件里的服务商提示（导入时仅供面板预选，owc 侧不保证同名）。 */
    providerHint?: string;
    /** `request/header` 事件里的模型提示。 */
    modelHint?: string;
  };
  /** 直接可进 `serializeSession` 的消息列表。 */
  messages: ChatMessage[];
  /** 仅当存在可锚定的压缩映射时给出。 */
  ledger?: { compacted: CompactionRecord };
  report: ConversionReport;
  /** M5 占位：子代理转录嵌套映射不在本里程碑实现（字段恒缺省）。 */
  subagentChildren?: never;
}

/**
 * 导入侧的可选注入点（M4a）。
 *
 * {@link DshConversionOptions.resolveAttachment} 由 host 注入：按 attachmentId 读 dsh 附件字节并
 * base64 内联（host 侧实现 = `readDshAttachment(dshHome, id)` + `toString("base64")`）。
 * 转换函数本身保持纯函数——不碰文件系统，也不依赖注入方是同步还是异步（注入方必须同步返回，
 * 因为本模块整体是同步变换）。
 */
export interface DshConversionOptions {
  /**
   * 附件字节解析器：返回 `{mediaType, data(base64)}`；返回 undefined 表示读不到（降级为文本占位）。
   */
  resolveAttachment?: (attachmentId: string) => { mediaType: string; data: string } | undefined;
}

/** 转换过程的内部累加器（最终收敛为 {@link ConversionReport}）。 */
interface ConversionAccumulator {
  /** 丢弃账（原始。键序在收敛时排序）。 */
  dropped: Record<string, number>;
  /** 警告（处理顺序）。 */
  warnings: string[];
  /** 未映射的内容块类型 → 个数（收敛时聚合成警告）。 */
  unmapped: Record<string, number>;
  counts: ConversionCounts;
  /** 事件 time 非法、createdAt 回退会话时间的次数（收敛时聚合成一条警告）。 */
  badTimes: number;
  /** 会话 createdAt（事件 time 非法时的兜底，保证确定性）。 */
  fallbackCreatedAt: string;
  /** 是否注入了附件解析器（决定图片降级警告的措辞，也决定 image 块是否可能内联）。 */
  hasResolver: boolean;
  /** 附件解析器（缺省 = 一律占位）。 */
  resolveAttachment?: ((attachmentId: string) => { mediaType: string; data: string } | undefined) | undefined;
}

/** 内容块转换上下文（thinking 归属、replay 元数据对齐、降级记账）。 */
interface BlockContext {
  acc: ConversionAccumulator;
  /** 产出该块的消息的 provider 归属。 */
  provider: string;
  /** assistant message 的 `source.replayState.blocks`（reasoning 的 signature/redacted 落点）。 */
  replayBlocks?: readonly unknown[] | undefined;
  /** 块在所属消息 content 中的下标（与 replayBlocks 逐位对齐）。 */
  index: number;
  /** 警告定位前缀，如 `seq 12 assistant/message[1]`。 */
  where: string;
}

/** 最终 surface 列表里的一项（按处理顺序排列）。 */
interface SurfaceItem {
  /** 事件 seq（replace 语义按 seq 判定被遮蔽区间）。 */
  seq: number;
  /** surface 事件类型。 */
  type: string;
  /** 事件信封原样引用（不改写输入）。 */
  event: Record<string, unknown>;
}

/** 未知 JSON 值取数组视图（非数组返回空数组，避免到处判空）。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 未知 JSON 值取字符串（其它类型返回 undefined）。 */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 事件信封里的整数 seq（非法时 {@link NO_SEQ}）。 */
function seqOf(event: Record<string, unknown>): number {
  return typeof event.seq === "number" && Number.isInteger(event.seq) ? event.seq : NO_SEQ;
}

/** 取消息的 createdAt：事件 time 非法时回退会话 createdAt 并记账。 */
function createdAtOf(event: Record<string, unknown>, acc: ConversionAccumulator): string {
  const iso = isoOfMs(event.time);
  if (iso !== undefined) return iso;
  acc.badTimes += 1;
  return acc.fallbackCreatedAt;
}

/** 丢弃记账（按事件类型累计）。 */
function countDrop(acc: ConversionAccumulator, type: string): void {
  acc.dropped[type] = (acc.dropped[type] ?? 0) + 1;
}

/** 未映射内容块记账（收敛为聚合警告）。 */
function countUnmapped(acc: ConversionAccumulator, type: string): void {
  acc.unmapped[type] = (acc.unmapped[type] ?? 0) + 1;
}

/** 一条降级警告。 */
function warn(acc: ConversionAccumulator, message: string): void {
  acc.warnings.push(message);
}

/** 附件引用（dsh `image`/`file` 块的 `attachment` 字段）。 */
interface AttachmentRef {
  attachmentId?: string | undefined;
  name?: string | undefined;
  bytes?: number | undefined;
}

/** 读附件引用的三个字段（块上直挂同名字段时也接受）。 */
function attachmentOf(block: Record<string, unknown>): AttachmentRef {
  const attachment = asRecord(block.attachment);
  const attachmentId = str(attachment?.attachmentId) ?? str(block.attachmentId);
  const name = str(attachment?.name) ?? str(block.name);
  const bytes = typeof attachment?.bytes === "number" ? attachment.bytes : typeof block.bytes === "number" ? block.bytes : undefined;
  return { attachmentId, name, bytes };
}

/** 图片块的文本占位（纯文本形式；是否计账由调用方决定）。 */
function imagePlaceholderText(block: Record<string, unknown>): string {
  const { attachmentId } = attachmentOf(block);
  return `[dsh 图片附件 ${attachmentId ?? "?"}]`;
}

/**
 * 尝试把 dsh 图片块内联为 owc `image` 块（M4a）。
 *
 * 命中条件：注入了解析器、块里有 attachmentId、解析器返回了非空的 mediaType/data。
 * 无论命中与否都计一次 `counts.images`；未命中再计一次 `counts.imagesMissing`（降级不静默）。
 */
function resolveImageBlock(block: Record<string, unknown>, ctx: BlockContext): ImageContent | undefined {
  const { attachmentId } = attachmentOf(block);
  ctx.acc.counts.images += 1;
  const resolved = attachmentId === undefined ? undefined : ctx.acc.resolveAttachment?.(attachmentId);
  if (
    resolved !== undefined
    && typeof resolved.mediaType === "string" && resolved.mediaType.length > 0
    && typeof resolved.data === "string" && resolved.data.length > 0
  ) {
    return { type: "image", mediaType: resolved.mediaType, data: resolved.data };
  }
  ctx.acc.counts.imagesMissing += 1;
  return undefined;
}

/** 图片块 → owc 内容块：能内联则 `image{mediaType,data}`，否则文本占位。 */
function imageBlockOf(block: Record<string, unknown>, ctx: BlockContext): MessageContent {
  return resolveImageBlock(block, ctx) ?? { type: "text", text: imagePlaceholderText(block) };
}

/**
 * 纯占位路径：摘要/结果拍平为文本时使用（owc 账本与摘要文本没有媒体槽位），
 * 一律按降级记账——即便附件可读也无法在这里承载字节。
 */
function imagePlaceholder(block: Record<string, unknown>, ctx: BlockContext): TextContent {
  ctx.acc.counts.images += 1;
  ctx.acc.counts.imagesMissing += 1;
  return { type: "text", text: imagePlaceholderText(block) };
}

/** 文件块降级：占位文本（只有引用元数据，没有字节）。 */
function filePlaceholder(block: Record<string, unknown>): TextContent {
  const { name, bytes } = attachmentOf(block);
  return { type: "text", text: `[dsh 文件附件 ${name ?? "?"} (${bytes ?? 0}B)]` };
}

/** reasoning 块 → thinking 块（signature/redacted 从块上或 replay 元数据取）。 */
function thinkingOf(block: Record<string, unknown>, ctx: BlockContext): ThinkingContent {
  const replay = asRecord(asArray(ctx.replayBlocks)[ctx.index]);
  // replay 元数据两种协议各有落点：anthropic-messages 写 signature/redacted，
  // openai-responses 把完整 reasoning item JSON 写在 `item`（owc 侧存 signature，见 types.ts）。
  const signature = str(block.signature) ?? str(replay?.signature) ?? str(replay?.item);
  const redacted = str(block.redacted) ?? str(replay?.redacted);
  return {
    type: "thinking",
    text: str(block.text) ?? "",
    provider: ctx.provider,
    ...(signature === undefined ? {} : { signature }),
    ...(redacted === undefined ? {} : { redacted }),
  };
}

/**
 * `tool-call.arguments`（JSON 字符串）→ `tool_call.input`。
 * 解析失败或结果不是 JSON 对象时降级为 `{_raw: 原串}` 并警告（保真留给人工/后续里程碑）。
 */
function parseToolArguments(raw: unknown, ctx: BlockContext, label: string): Record<string, unknown> {
  if (typeof raw !== "string") {
    warn(ctx.acc, `${ctx.where} 工具调用 ${label} 的 arguments 不是字符串，已降级为 {_raw}`);
    return { _raw: raw === undefined ? "" : String(raw) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(ctx.acc, `${ctx.where} 工具调用 ${label} 的 arguments 不是合法 JSON，已降级为 {_raw}`);
    return { _raw: raw };
  }
  const record = asRecord(parsed);
  if (record !== undefined) return record;
  warn(ctx.acc, `${ctx.where} 工具调用 ${label} 的 arguments 解析结果不是 JSON 对象，已降级为 {_raw}`);
  return { _raw: raw };
}

/** `tool-call` 块 → owc `tool_call` 块。 */
function toolCallOf(block: Record<string, unknown>, ctx: BlockContext): ToolCallContent {
  const id = str(block.id) ?? "";
  const name = str(block.name) ?? "";
  return { type: "tool_call", id, name, input: parseToolArguments(block.arguments, ctx, name || id || "?") };
}

/**
 * `tool-result` 块 → owc `tool_result` 块：结果内容拍平成文本，
 * 其中的图片块（M4a）尝试进 `media[]`（`ToolResultContent.media`）。
 */
function toolResultOf(block: Record<string, unknown>, ctx: BlockContext): ToolResultContent {
  const flattened = flattenResultBlocks(asArray(block.content), ctx);
  return {
    type: "tool_result",
    toolCallId: str(block.toolCallId) ?? "",
    content: flattened.text,
    isError: block.isError === true,
    ...(flattened.media.length === 0 ? {} : { media: flattened.media }),
  };
}

/** 单个内容块 → owc 内容块（不可映射的块类型记账丢弃）。 */
function convertBlock(raw: unknown, ctx: BlockContext): MessageContent | undefined {
  const block = asRecord(raw);
  if (block === undefined) {
    countUnmapped(ctx.acc, "(非对象块)");
    return undefined;
  }
  switch (str(block.type) ?? "") {
    case "text":
      return { type: "text", text: str(block.text) ?? "" };
    case "reasoning":
      return thinkingOf(block, ctx);
    case "tool-call":
      return toolCallOf(block, ctx);
    // v3 中 tool-result 块只出现在 tool/result 事件里；此处保留通用映射（旧代际残留）
    case "tool-result":
      return toolResultOf(block, ctx);
    case "image":
      return imageBlockOf(block, ctx);
    case "file":
      return filePlaceholder(block);
    default:
      countUnmapped(ctx.acc, str(block.type) ?? "(无 type)");
      return undefined;
  }
}

/** 消息 content 数组 → owc 内容块数组。 */
function convertBlocks(content: unknown, base: Omit<BlockContext, "index">): MessageContent[] {
  const blocks: MessageContent[] = [];
  for (const [index, raw] of asArray(content).entries()) {
    const block = convertBlock(raw, { ...base, index });
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/**
 * 结果/摘要类内容块拍平为文本（`\n` 拼接）：
 * text/reasoning 取原文；image 走占位并计数；file 走占位；嵌套 tool-result 递归拍平；
 * 其它类型记账丢弃。
 *
 * 注意：这是**纯文本**拍平路径（压缩摘要用）。工具结果的图片另有承载位置，
 * 走 {@link flattenResultBlocks}（把可读图片放进 `media[]`）。
 */
function flattenBlocks(content: unknown, ctx: BlockContext): string {
  const parts: string[] = [];
  for (const raw of asArray(content)) {
    const block = asRecord(raw);
    if (block === undefined) {
      countUnmapped(ctx.acc, "(非对象块)");
      continue;
    }
    switch (str(block.type) ?? "") {
      case "text":
        parts.push(str(block.text) ?? "");
        break;
      case "reasoning":
        parts.push(str(block.text) ?? "");
        break;
      case "image":
        parts.push(imagePlaceholder(block, ctx).text);
        break;
      case "file":
        parts.push(filePlaceholder(block).text);
        break;
      case "tool-result":
        parts.push(flattenBlocks(asArray(block.content), ctx));
        break;
      default:
        countUnmapped(ctx.acc, str(block.type) ?? "(无 type)");
    }
  }
  return parts.join("\n");
}

/**
 * 工具结果内容拍平（M4a）：文本照旧拼接，可读图片进 `media[]`（读不出则文本占位）。
 * @returns 拍平文本与（可能为空的）媒体块数组。
 */
function flattenResultBlocks(content: unknown, ctx: BlockContext): { text: string; media: ImageContent[] } {
  const parts: string[] = [];
  const media: ImageContent[] = [];
  for (const raw of asArray(content)) {
    const block = asRecord(raw);
    if (block === undefined) {
      countUnmapped(ctx.acc, "(非对象块)");
      continue;
    }
    switch (str(block.type) ?? "") {
      case "text":
      case "reasoning":
        parts.push(str(block.text) ?? "");
        break;
      case "image": {
        const image = resolveImageBlock(block, ctx);
        if (image === undefined) parts.push(imagePlaceholderText(block));
        else media.push(image);
        break;
      }
      case "file":
        parts.push(filePlaceholder(block).text);
        break;
      case "tool-result": {
        const nested = flattenResultBlocks(asArray(block.content), ctx);
        parts.push(nested.text);
        media.push(...nested.media);
        break;
      }
      default:
        countUnmapped(ctx.acc, str(block.type) ?? "(无 type)");
    }
  }
  return { text: parts.join("\n"), media };
}

/** 解析 `surfaceOp` 里的 replace 区间（`{op:'replace',startSeq,endSeq}`；非法返回 undefined）。 */
function replaceRangeOf(value: unknown): { startSeq: number; endSeq: number } | undefined {
  const record = asRecord(value);
  if (record?.op !== "replace") return undefined;
  const startSeq = record.startSeq;
  const endSeq = record.endSeq;
  if (typeof startSeq !== "number" || typeof endSeq !== "number") return undefined;
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) return undefined;
  return { startSeq, endSeq };
}

/**
 * surface 重建：按事件顺序维护 surface 列表。
 * `surfaceOp === 'append'`（或缺省）追加；`{op:'replace',startSeq,endSeq}` **原位替换** ——
 * 先移除 seq 落在 `[startSeq,endSeq]` 内的已有项，再把这些项在列表里的**首个下标**处插回本事件
 * （与上游会话投影的 splice(first, removed.length, seq) 语义一致：被替换的事件必然早于替换者，
 * 且替换后仍停留在原位置，而不是被挪到末尾）。区间内没有任何项时退化为追加。
 * @returns 最终 surface 项（顺序即转换顺序）。
 */
function rebuildSurface(events: readonly Record<string, unknown>[], acc: ConversionAccumulator): SurfaceItem[] {
  const items: SurfaceItem[] = [];
  for (const event of events) {
    const type = str(event.type) ?? "";
    if (!SURFACE_TYPES.includes(type)) continue;
    const seq = seqOf(event);
    const range = event.surfaceOp === undefined || event.surfaceOp === "append" ? undefined : replaceRangeOf(event.surfaceOp);
    if (event.surfaceOp !== undefined && event.surfaceOp !== "append" && range === undefined) {
      warn(acc, `seq ${seq} 的 ${type} surfaceOp 不是合法的 replace（需 op/startSeq/endSeq），按追加处理`);
    }
    if (range !== undefined) {
      // 倒序删除：删完 first 即区间内最小下标（原位插入点）
      let first: number | undefined;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index]!;
        if (item.seq >= range.startSeq && item.seq <= range.endSeq) {
          items.splice(index, 1);
          first = index;
        }
      }
      if (first !== undefined) {
        items.splice(first, 0, { seq, type, event });
        continue;
      }
    }
    items.push({ seq, type, event });
  }
  return items;
}

/** 事件信封里的 data（非对象时给空对象）。 */
function dataOf(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.data) ?? {};
}

/** 消息载荷：`user/message` 的 data 即消息本身，assistant/tool 在 `data.message` 里。 */
function payloadOf(data: Record<string, unknown>): Record<string, unknown> {
  return asRecord(data.message) ?? data;
}

/** 消息的 provider 归属（assistant 的 `source.provider`；缺省 {@link FALLBACK_PROVIDER}）。 */
function providerOf(payload: Record<string, unknown>): string {
  const source = asRecord(payload.source);
  const provider = str(source?.provider);
  return provider !== undefined && provider.length > 0 ? provider : FALLBACK_PROVIDER;
}

/** assistant message 的 replay 元数据块数组（`source.replayState.blocks`）。 */
function replayBlocksOf(payload: Record<string, unknown>): readonly unknown[] | undefined {
  const state = asRecord(asRecord(payload.source)?.replayState);
  const blocks = state?.blocks;
  return Array.isArray(blocks) ? blocks : undefined;
}

/** 消息 id：`data.message.id`（user 为 `data.id`）优先，缺省 `dsh-<seq>` 保证确定性。 */
function messageIdOf(payload: Record<string, unknown>, seq: number): string {
  const id = str(payload.id);
  return id !== undefined && id.length > 0 ? id : `${GENERATED_ID_PREFIX}${seq}`;
}

/**
 * tool/result 消息的 toolCallId：`message.toolCallId`（v4 一等 tool 消息）优先，
 * 其次 `source.callId`（v3 的 `source:{kind:'tool',callId}`），最后 v3 包装块上的 `toolCallId`。
 */
function toolCallIdOf(message: Record<string, unknown>, wrapper?: Record<string, unknown>): string {
  return str(message.toolCallId) ?? str(asRecord(message.source)?.callId) ?? str(wrapper?.toolCallId) ?? "";
}

/** tool/result 的 isError：message 级（v4）优先，其次 v3 包装块上的 isError。 */
function isErrorOf(message: Record<string, unknown>, wrapper?: Record<string, unknown>): boolean {
  if (typeof message.isError === "boolean") return message.isError;
  return wrapper?.isError === true;
}

/**
 * `tool/result` 消息 → owc `tool_result` 块（两代形态都吃）：
 * - v3 包装形态：`message.content = [{type:'tool-result', toolCallId, content:[...], isError}]`；
 * - v4 一等形态：`role:'tool'` + `message.toolCallId` + `content` 即结果块数组（无包装）+ `message.isError`。
 * toolCallId / isError 一律按 {@link toolCallIdOf} / {@link isErrorOf} 的优先级取值，
 * 结果内容按 {@link flattenResultBlocks} 拍平成文本（可读图片进 `media[]`）。
 */
function convertToolResult(message: Record<string, unknown>, ctx: BlockContext): MessageContent[] {
  const content = asArray(message.content);
  const only = content.length === 1 ? asRecord(content[0]) : undefined;
  if (only !== undefined && str(only.type) === "tool-result") {
    const block = toolResultOf(only, ctx);
    return [{
      ...block,
      toolCallId: toolCallIdOf(message, only),
      isError: isErrorOf(message, only),
    }];
  }
  const flattened = flattenResultBlocks(content, ctx);
  const result: ToolResultContent = {
    type: "tool_result",
    toolCallId: toolCallIdOf(message),
    content: flattened.text,
    isError: isErrorOf(message),
    ...(flattened.media.length === 0 ? {} : { media: flattened.media }),
  };
  return [result];
}

/** surface 项 → ChatMessage（system/message 不转换：丢弃计数由 {@link classifyEvents} 统一记）。 */
function convertSurfaceItem(
  item: SurfaceItem,
  messages: ChatMessage[],
  seqToMessage: Map<number, { id: string; index: number }>,
  acc: ConversionAccumulator,
): void {
  const data = dataOf(item.event);
  // system/message 永不转换（插件注入的提示词由 owc 提示词层重建），连 createdAt 都不必算
  if (item.type === "system/message") return;
  const createdAt = createdAtOf(item.event, acc);
  const message = payloadOf(data);
  const id = messageIdOf(message, item.seq);
  if (item.type === "user/message") {
    const base = { acc, provider: providerOf(message), where: `seq ${item.seq} user/message` };
    messages.push({ id, role: "user", content: convertBlocks(message.content, base), createdAt });
    acc.counts.user += 1;
  } else if (item.type === "assistant/message") {
    const base = {
      acc,
      provider: providerOf(message),
      replayBlocks: replayBlocksOf(message),
      where: `seq ${item.seq} assistant/message`,
    };
    messages.push({ id, role: "assistant", content: convertBlocks(message.content, base), createdAt });
    acc.counts.assistant += 1;
  } else if (item.type === "tool/result") {
    const base = { acc, provider: providerOf(message), where: `seq ${item.seq} tool/result` };
    messages.push({ id, role: "tool", content: convertToolResult(message, { ...base, index: 0 }), createdAt });
    acc.counts.tool += 1;
  }
  seqToMessage.set(item.seq, { id, index: messages.length - 1 });
}

/**
 * 工具配对校验：孤儿 tool_result（无对应 tool_call）**整条消息降级为 user 角色的文本消息** + 警告；
 * 孤儿 tool_call 保留不动（继续对话时模型可感知中断）。
 *
 * 为什么角色也要改：owc 的 provider 适配层按角色投递内容——`role:'tool'` 的正文只有在
 * tool_result 块里才随工具结果通道下发，把 `tool_result` 换成一个 text 块后，该角色在
 * Anthropic/OpenAI 系端点上会被整条吞掉（模型看不到「这里曾有个工具结果」）。
 * 降级为 user 文本消息（前缀 `[工具结果 <toolCallId>]`）才能让模型真正看到它。
 * 计数同步挪位：该消息的 `counts.tool` 减一、`counts.user` 加一（如实反映产物形态）。
 * @returns 处理过的孤儿数。
 */
function repairToolPairing(messages: ChatMessage[], acc: ConversionAccumulator): number {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") callIds.add(block.id);
    }
  }
  let orphans = 0;
  for (const [index, message] of messages.entries()) {
    let messageOrphans = 0;
    const content = message.content.map((block): MessageContent => {
      if (block.type !== "tool_result" || callIds.has(block.toolCallId)) return block;
      messageOrphans += 1;
      return { type: "text", text: `[工具结果 ${block.toolCallId}] ${block.content}` };
    });
    if (messageOrphans === 0) continue;
    orphans += messageOrphans;
    messages[index] = { ...message, role: "user", content };
    acc.counts.tool -= 1;
    acc.counts.user += 1;
  }
  if (orphans > 0) {
    warn(acc, `${orphans} 个孤儿 tool_result（无对应 tool_call）已降级为 user 角色的文本消息（前缀 [工具结果 <toolCallId>]），模型可见`);
  }
  return orphans;
}

/** 消息里首个非空文本块（`session/title` 的 messageSeqs 解析用）。 */
function firstTextOf(message: ChatMessage | undefined): string | undefined {
  for (const block of message?.content ?? []) {
    if (block.type === "text" && block.text.trim().length > 0) return block.text.trim();
  }
  return undefined;
}

/**
 * `session/title` → meta.title：取**最后一条** title 事件（重命名以最新为准），
 * 再按 `messageSeqs` 顺序找首个命中已转换消息的文本块，截 {@link TITLE_MAX_LENGTH}；
 * messageSeqs 一个都没命中时回退事件自带的 `title` 字段（避免整条标题丢失）。
 */
function titleOf(
  events: readonly Record<string, unknown>[],
  messages: readonly ChatMessage[],
  seqToMessage: Map<number, { id: string; index: number }>,
): string | undefined {
  const titles = events.filter((event) => str(event.type) === "session/title");
  const last = titles[titles.length - 1];
  if (last === undefined) return undefined;
  const data = dataOf(last);
  for (const raw of asArray(data.messageSeqs)) {
    if (typeof raw !== "number") continue;
    const mapped = seqToMessage.get(raw);
    const text = firstTextOf(mapped === undefined ? undefined : messages[mapped.index]);
    if (text !== undefined) return text.slice(0, TITLE_MAX_LENGTH);
  }
  const fallback = str(data.title)?.trim() ?? "";
  return fallback.length === 0 ? undefined : fallback.slice(0, TITLE_MAX_LENGTH);
}

/** 压缩事件的被遮蔽 seq 列表（`shadowedSeqs` 为空时用 `shadowedRange` 闭区间兜底）。 */
function shadowedSeqsOf(data: Record<string, unknown>): number[] {
  const seqs = asArray(data.shadowedSeqs).filter((value): value is number => typeof value === "number" && Number.isInteger(value));
  if (seqs.length > 0) return [...new Set(seqs)];
  return rangeSeqsOf(data);
}

/** `shadowedRange` 的闭区间（`{start,end}`；非法返回 undefined）。 */
function shadowedRangeOf(data: Record<string, unknown>): { start: number; end: number } | undefined {
  const range = asRecord(data.shadowedRange);
  const start = range?.start;
  const end = range?.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return undefined;
  }
  return { start, end };
}

/**
 * `shadowedRange` 展开为闭区间 seq 列表。
 * 闭区间口径与 surface replace（`[startSeq,endSeq]` 含两端）一致：压缩遮蔽的正是这段可见历史。
 */
function rangeSeqsOf(data: Record<string, unknown>): number[] {
  const range = shadowedRangeOf(data);
  if (range === undefined) return [];
  const seqs: number[] = [];
  for (let seq = range.start; seq <= range.end; seq += 1) seqs.push(seq);
  return seqs;
}

/** 在候选 seq 里找 seq 最大、且已转换为消息的那个（= "最后被遮蔽的 surface 事件"）。 */
function lastMappedMessage(
  seqs: readonly number[],
  seqToMessage: Map<number, { id: string; index: number }>,
): { id: string; index: number } | undefined {
  let found: { id: string; index: number } | undefined;
  let best = Number.NEGATIVE_INFINITY;
  for (const seq of seqs) {
    const mapped = seqToMessage.get(seq);
    if (mapped !== undefined && seq > best) {
      best = seq;
      found = mapped;
    }
  }
  return found;
}

/**
 * `compaction/prune` 一律丢弃 + 警告（修正点 1；条数由 {@link classifyEvents} 统一记入丢弃账）。
 * owc 的 `evicted` 账本条目与 artifact 落盘、占位符替换强耦合；只记录不驱逐会造成
 * 「账本说已驱逐、正文仍在」的不一致视图，比不映射更糟。
 */
function warnPrunes(acc: ConversionAccumulator): void {
  const count = acc.dropped["compaction/prune"] ?? 0;
  if (count > 0) {
    warn(acc, `${count} 条 compaction/prune 未做账本映射（owc evicted 与 artifact 落盘强耦合，保守语义会造成不一致视图），已丢弃并计数`);
  }
}

/**
 * 该 surface 事件是不是压缩 checkpoint 消息：`user/message` 且 `source` 打的是压缩标记。
 * 两种形态都吃：v4/当前代际 `{kind:'compact-checkpoint', compactionId}`（dsh 的
 * `compactCheckpointSource`）与旧代际 `{kind:'plugin', plugin:'compact', compactionId}`。
 */
function isCompactCheckpointSource(source: Record<string, unknown> | undefined): boolean {
  if (source === undefined) return false;
  if (source.kind === "compact-checkpoint") return true;
  return source.kind === "plugin" && source.plugin === "compact";
}

/**
 * 找某条 `compaction/summary` 对应的 checkpoint 消息（= dsh 压缩落地后顶替被遮蔽历史的那条
 * `user/message`）。命中条件（全部满足）：
 * 1. 事件的 `source` 是压缩 checkpoint（{@link isCompactCheckpointSource}；`user/message` 的 source
 *    直接挂在 `data` 上，`data.message.source` 由 {@link payloadOf} 统一取）；
 * 2. 有 compactionId 时，checkpoint 的 compactionId 必须与 summary 的一致；
 * 3. `surfaceOp` 是 replace，且 `[startSeq,endSeq]` 覆盖 summary 的 `shadowedRange`；
 * 4. 该事件确实转换成了消息（在最终 surface 里）。
 * 命中多条时取最后一条（与 summary「取最后一条」的口径一致）。
 * @returns 该 checkpoint 转换出的消息定位（id + 下标）；没有命中返回 undefined。
 */
function checkpointMessageOf(
  events: readonly Record<string, unknown>[],
  data: Record<string, unknown>,
  seqToMessage: Map<number, { id: string; index: number }>,
): { id: string; index: number } | undefined {
  const compactionId = str(data.compactionId);
  const shadowed = shadowedRangeOf(data);
  let found: { id: string; index: number } | undefined;
  for (const event of events) {
    if (str(event.type) !== "user/message") continue;
    const source = asRecord(payloadOf(dataOf(event)).source);
    if (!isCompactCheckpointSource(source)) continue;
    const checkpointId = str(source?.compactionId);
    if (compactionId !== undefined && checkpointId !== undefined && checkpointId !== compactionId) continue;
    const range = replaceRangeOf(event.surfaceOp);
    if (range === undefined) continue;
    if (shadowed !== undefined && !(range.startSeq <= shadowed.start && range.endSeq >= shadowed.end)) continue;
    const mapped = seqToMessage.get(seqOf(event));
    if (mapped !== undefined) found = mapped;
  }
  return found;
}

/**
 * 压缩映射（修正点 1、2 之外的正路）：取**最后一条** `compaction/summary`，锚点按两级取：
 * 1. 首选该 summary 对应的 **checkpoint 消息**（{@link checkpointMessageOf}）——dsh 压缩完成后会在
 *    summary 之后追加一条 `user/message` checkpoint（`source:{kind:'compact-checkpoint'|plugin/compact}`，
 *    `surfaceOp.replace` 恰好覆盖 shadowed span），并把被遮蔽的 surface 事件移出最终 surface：
 *    因此「在 shadowedSeqs 里找已转换消息」必然落空，只有锚到 checkpoint 才能让 owc 视图用摘要
 *    替换「含 checkpoint 在内」的前缀；
 * 2. 回退：用 `shadowedSeqs`（空则 `shadowedRange`）里 seq 最大、且已转换为消息的 surface 事件
 *    （兼容没有 checkpoint 的合成/历史文件）。
 * 两级都找不到 → 放弃映射 + 警告。summary 文本始终取 `data.summary`。
 */
function buildLedger(
  events: readonly Record<string, unknown>[],
  seqToMessage: Map<number, { id: string; index: number }>,
  acc: ConversionAccumulator,
): DshSessionConversion["ledger"] {
  const summaries = events.filter((event) => str(event.type) === "compaction/summary");
  const last = summaries[summaries.length - 1];
  if (last === undefined) return undefined;
  if (summaries.length > 1) {
    warn(acc, `存在 ${summaries.length} 条 compaction/summary：按 owc 单 compacted 语义只采用 seq ${seqOf(last)} 的一条`);
  }
  const data = dataOf(last);
  const anchor = checkpointMessageOf(events, data, seqToMessage)
    ?? lastMappedMessage(shadowedSeqsOf(data), seqToMessage)
    ?? lastMappedMessage(rangeSeqsOf(data), seqToMessage);
  if (anchor === undefined) {
    warn(acc, `compaction/summary（seq ${seqOf(last)}）既找不到对应的 checkpoint 消息，其 shadowed 区间也没有命中任何已转换的 surface 消息，放弃压缩映射`);
    return undefined;
  }
  const summary = flattenBlocks(asArray(data.summary), {
    acc,
    provider: str(data.provider) ?? FALLBACK_PROVIDER,
    where: `seq ${seqOf(last)} compaction/summary`,
    index: 0,
  });
  const compacted: CompactionRecord = {
    uptoIndex: anchor.index + 1,
    uptoMessageId: anchor.id,
    mode: "overview",
    summary,
    instructions: [],
    createdAt: createdAtOf(last, acc),
  };
  return { compacted };
}

/** `request/header` → providerHint/modelHint（取最后一条 = 会话当前配置）。 */
function hintsOf(events: readonly Record<string, unknown>[]): { providerHint?: string; modelHint?: string } {
  const headers = events.filter((event) => str(event.type) === "request/header");
  const last = headers[headers.length - 1];
  if (last === undefined) return {};
  const header = asRecord(dataOf(last).header);
  const config = asRecord(header?.config) ?? header;
  const provider = str(config?.provider);
  const model = str(config?.model);
  return {
    ...(provider === undefined || provider.length === 0 ? {} : { providerHint: provider }),
    ...(model === undefined || model.length === 0 ? {} : { modelHint: model }),
  };
}

/** 事件流分类计数：surface（含被 replace 遮蔽掉的）与其余事件类型进丢弃账。 */
function classifyEvents(
  events: readonly Record<string, unknown>[],
  surfaceSeqs: ReadonlySet<number>,
  acc: ConversionAccumulator,
): void {
  let shadowedSurface = 0;
  for (const event of events) {
    const type = str(event.type) ?? "unknown";
    if (!SURFACE_TYPES.includes(type)) {
      if (!META_EVENT_TYPES.includes(type)) countDrop(acc, type);
      continue;
    }
    // system/message 永不转换（插件注入的提示词由 owc 提示词层重建）：一律计数。
    if (type === "system/message") {
      countDrop(acc, type);
      continue;
    }
    if (surfaceSeqs.has(seqOf(event))) continue;
    // 被 replace 遮蔽且未再出现的 surface 事件：其内容通常已由替换事件承载，但确实没转换。
    countDrop(acc, type);
    shadowedSurface += 1;
  }
  if (shadowedSurface > 0) {
    warn(acc, `${shadowedSurface} 个 surface 事件被 surfaceOp replace 遮蔽后未再出现，未转换为消息`);
  }
}

/** 累加器 → 报告（键序排序 + 聚合警告，结果稳定可复现）。 */
function toReport(acc: ConversionAccumulator): ConversionReport {
  const sorted = (source: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(source).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  for (const [type, count] of Object.entries(sorted(acc.unmapped))) {
    warn(acc, `未映射的内容块类型 ${type}：${count} 个（已丢弃）`);
  }
  if (acc.counts.imagesMissing > 0) {
    // 措辞分两种：未注入解析器（M3a 行为，附件字节没人给）vs 注入了但没命中（附件缺失/损坏）。
    warn(
      acc,
      acc.hasResolver
        ? `${acc.counts.imagesMissing}/${acc.counts.images} 个图片附件未命中 resolver（附件缺失或不可读），已降级为文本占位`
        : `图片附件本里程碑只做文本占位（附件字节留待 M4）：${acc.counts.imagesMissing}/${acc.counts.images} 个`,
    );
  }
  if (acc.badTimes > 0) {
    warn(acc, `${acc.badTimes} 个事件缺少合法的 time，createdAt 回退为会话 createdAt`);
  }
  return { droppedEvents: sorted(acc.dropped), warnings: acc.warnings, counts: acc.counts };
}

/**
 * dsh 会话（`{header, events}`；读支持 v3/v4，见 `dsh-sync-dsh.ts`）→ owc 会话片段
 * （meta 片段 + 消息 + 可选账本 + 报告）。
 *
 * 纯函数：不改写入参，不做任何 IO；同一输入必得同一输出（消息 id 用 `dsh-<seq>` 兜底保证确定性）。
 * 图片字节经 {@link DshConversionOptions.resolveAttachment} 注入（host 侧读附件 + base64），
 * 因此本模块自身保持同步纯变换：不注入解析器时行为与 M3a 完全一致（一律文本占位）。
 * @param header - 会话头行（v3/v4：createdAt 毫秒、cwd 等）。
 * @param events - 事件行数组（seq 稠密，由 M1 解码层保证）。
 * @param options - 可选注入点（附件解析器）。
 * @returns 转换产物（`meta` 只含会话级字段；`messages` 可直接进 `serializeSession`）。
 */
export function convertDshSession(
  header: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  options?: DshConversionOptions,
): DshSessionConversion {
  const createdAtOfSession = isoOfMs(header.createdAt) ?? isoOfMs(events[0]?.time);
  const fallbackCreatedAt = createdAtOfSession ?? new Date(0).toISOString();
  const acc: ConversionAccumulator = {
    dropped: {},
    warnings: [],
    unmapped: {},
    counts: { user: 0, assistant: 0, tool: 0, images: 0, imagesMissing: 0 },
    badTimes: 0,
    fallbackCreatedAt,
    hasResolver: options?.resolveAttachment !== undefined,
    resolveAttachment: options?.resolveAttachment,
  };
  // 头行与首个事件都没有合法时间时才用 1970-01-01 兜底（时间戳 0 会让会话排在列表最末）；
  // 这种会话通常意味着文件被截断/外部拼接，必须让用户看见（过去是静默兜底）。
  if (createdAtOfSession === undefined) {
    warn(acc, `会话头行（createdAt=${String(header.createdAt)}）与首个事件的 time 都不是合法毫秒时间戳，会话时间回退为 ${fallbackCreatedAt}`);
  }

  const surface = rebuildSurface(events, acc);
  classifyEvents(events, new Set(surface.map((item) => item.seq)), acc);
  warnPrunes(acc);

  const messages: ChatMessage[] = [];
  const seqToMessage = new Map<number, { id: string; index: number }>();
  for (const item of surface) convertSurfaceItem(item, messages, seqToMessage, acc);
  repairToolPairing(messages, acc);

  const title = titleOf(events, messages, seqToMessage);
  const ledger = buildLedger(events, seqToMessage, acc);
  const cwd = str(header.cwd);
  return {
    meta: {
      ...(title === undefined ? {} : { title }),
      ...(cwd === undefined || cwd.length === 0 ? {} : { cwd }),
      createdAt: fallbackCreatedAt,
      ...hintsOf(events),
    },
    messages,
    ...(ledger === undefined ? {} : { ledger }),
    report: toReport(acc),
  };
}
