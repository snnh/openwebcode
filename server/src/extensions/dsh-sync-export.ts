/**
 * dsh-sync 扩展 M4a：owc 会话 → dsh v3 会话文件（`session.v3.jsonl.zstd`）的写出器。
 *
 * 分工：
 * - {@link buildDshSessionEvents} 是**纯函数**：派生事件 → 工具生命周期重排 + 稠密重编 seq → 改写图片块 →
 *   追加标题与压缩生命周期，附件只收集不落地；
 * - {@link writeDshSession} 负责落盘（内容寻址写附件 + zstd 帧 + 回读自检 + 失败清理）。
 *
 * 事件映射**复用**既有实现：`server/src/dsh/web-protocol/session-events.ts` 的 {@link deriveSessionRecords}
 * （owc → dsh 的 wire 投影），本模块只做它不负责的四件事：图片附件化、工具生命周期重排、压缩导出、v3 文件封装。
 *
 * 已核实的格式约束（`.tmp/dsh-refs/session_session-format-v2-to-v3/src/payload.ts` 的 `assertV3Event`
 * 与 `validation.ts` 的 `restoreReleasedV3Artifact`，以及 `session-format-v0-to-v1` 的 payload/关系校验）：
 * - 事件信封 = `{type, seq, time, data}` + 可选 `ignorable`，`seq` 从 0 稠密，`time` 为非负安全整数；
 * - 四类 surface 事件必带 `surfaceOp`；`replace` 形态的键必须**恰好**是 `op/startSeq/endSeq`，
 *   两端点必须**严格小于**本事件 seq；`sourceEventSeqs` 必须是非空、不重复、且都早于本事件的 seq 列表；
 * - **工具生命周期**：`assistant/message` 的 `tool-call` 块先「广告」调用（callId→{name,arguments}），
 *   `tool/call` 必须在其**之后**且 name/arguments 精确匹配，`tool/result` 又必须已有对应生命周期；
 *   三者都要求落在同一个「已开启未结束」的 step 内。既有 wire 投影（`session-events.ts`）为兼容
 *   实时客户端把 `tool/call` 排在 `assistant/message` 之前，因此导出器在**不改变 wire 语义**的前提下
 *   对事件做一次后处理重排（见 {@link reorderAssistantToolCalls}），再稠密重编 seq。
 * - **压缩生命周期**（`turn: null` 形态）：必须整体落在末轮 `turn/end` 之后、无 open turn 时，
 *   顺序固定为 `compaction/start` → `compaction/summary` → checkpoint `user/message` → `compaction/end`；
 *   `compaction/summary` 的 required 键恰为 `{compactionId, summary, shadowedRange, shadowedSeqs,
 *   shadowedTokenCount, provider, model}`，其中 `shadowedSeqs` 必须**恰好等于当前 surface 的连续一段**，
 *   且必须在 checkpoint 改写 surface **之前**发出；
 *   checkpoint 是 `user/message`（**不是** system/message），`data.message.source = {kind:'plugin',
 *   plugin:'compact', compactionId}`，带 `surfaceOp={op:'replace',startSeq,endSeq}` 与
 *   `sourceEventSeqs`（覆盖被替换 span 的全部 surface seq）；
 * - image 块的 attachment 恰为 `{attachmentId, mediaType, bytes, width, height}`，
 *   mediaType ∈ {image/png|jpeg|webp|gif}，bytes 为非负整数、width/height 为正整数；
 * - `compaction/summary` 的 `summary` 是内容块数组；
 * - 头行可选键只有 `cwd`/`parentSession`/`origin`/`agentPreset`，且 `origin` 只能是 `'subagent'`
 *   （M5a 用它写子代理会话：`delegationDepth:1` + `parentSession` 父会话新 id + 可选 `agentPreset`）。
 *
 * 本模块不产生任何 `system/message`，因此 dsh v3 的「受保护 system head」约束天然满足
 * （`restoreReleasedV3Artifact` 只在出现 system/message 时检查 head；surface replace 也不得遮蔽 head）。
 * 产物口径：**通过 dsh 官方 `restoreReleasedV3Artifact` 校验**（见 `test/dsh-sync-export-official.test.ts`）。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as zlib from "node:zlib";
import { deriveSessionRecords } from "../dsh/web-protocol/session-events.js";
import type { ChatMessage, ImageContent } from "../sessions/types.js";
import { DSH_SYNC_SUPPORTED_GENERATION, decodeDshSessionFile, dshSessionDir, writeDshAttachment } from "./dsh-sync-dsh.js";
import { imageMediaType, imageSize } from "./dsh-sync-image-size.js";

/** dsh v3 会话文件名（当前代际的压缩容器）。 */
const SESSION_FILE_NAME = `session.v${DSH_SYNC_SUPPORTED_GENERATION}.jsonl.zstd`;

/** dsh 四类 surface 事件（用于筛 `sourceEventSeqs` 与计算压缩的当前 surface）。 */
const SURFACE_TYPES: readonly string[] = ["system/message", "user/message", "assistant/message", "tool/result"];

/** 图片无法内联时的占位文本（与导入侧占位措辞区分：这一侧是 owc 的图片）。 */
const OWC_IMAGE_PLACEHOLDER = "[owc 图片]";

/**
 * 压缩 checkpoint 的插件署名：dsh 只对 `plugin === 'compact'` 的 plugin source 放开
 * `compactionId`/`sourceCommandId` 键，且据此把 checkpoint 绑定到当前打开的压缩生命周期。
 */
const COMPACTION_PLUGIN_NAME = "compact";

/** `compaction/summary` 的 provider/model 必填非空串；会话缺少归属时用该占位值并记 warning。 */
const UNKNOWN_ATTRIBUTION = "unknown";

/** 标题事件的最大长度（与导入侧 TITLE_MAX_LENGTH 同口径）。 */
const TITLE_MAX_LENGTH = 120;

/** zstd 编码参数：与 dsh 自身一致（带内容校验和，逐帧校验）。 */
const ZSTD_CHECKSUM_OPTIONS: zlib.ZstdOptions = {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
};

/** 导出输入里的压缩记录（`ContextLedger.compacted` 的子集）。 */
export interface DshExportLedgerCompacted {
  /** 已压缩消息条数（`messages[0..uptoIndex)` 被摘要取代）。 */
  uptoIndex: number;
  /** 边界锚点：压缩时刻最后一条被压缩消息的 id（优先按它定位）。 */
  uptoMessageId?: string;
  /** 摘要正文。 */
  summary: string;
  /** 压缩时间（ISO；缺省用锚点事件时间）。 */
  createdAt?: string;
}

/** 导出输入。 */
export interface DshExportInput {
  /** dsh 数据目录绝对路径。 */
  dshHome: string;
  /** 会话工作目录，**必须是绝对路径**（dsh 头行校验要求绝对路径）。 */
  cwd: string;
  /**
   * 会话级元信息。
   *
   * `provider`/`model`（M4a 增补，可选）：dsh 的 `assistant/message.source` 必须是
   * `{kind:'model', provider, model}` 且两者**非空**（上游 `assertMessageEventShape` 的
   * `hasProviderModel`），owc 消息不逐条记录模型归属，只能由调用方按会话当前配置传入。
   * 缺省时不编造（留空串）并记一条 warning。
   */
  meta: { title?: string; createdAt?: string; provider?: string; model?: string };
  /** 消息历史（owc 侧形态，含 `data` 内联图片）。 */
  messages: ChatMessage[];
  /** 上下文账本（只用到 `compacted`）。 */
  ledger?: { compacted?: DshExportLedgerCompacted };
  /**
   * 子代理会话标记（M5a）：给出时头行写成 dsh 的子代理形态——
   * `origin:'subagent'` + `parentSession`（父会话的**新** dsh id）+ `delegationDepth:1`，
   * 可选的 `agentPreset` 即子代理 preset（来自 owc 转录的 `agent` 字段）。
   */
  subagent?: { parentSession: string; agentPreset?: string };
}

/** 待写盘的附件（纯函数只收集，`writeDshSession` 负责落地）。 */
interface DshExportAttachmentWrite {
  /** 附件字节（写入 `<dshHome>/attachments/v1/objects/...`）。 */
  bytes: Buffer;
  /** 已改写好的 dsh 图片块（`attachment.attachmentId` 即字节 sha256）。 */
  block: Record<string, unknown>;
}

/** {@link buildDshSessionEvents} 的产物（尚未落盘）。 */
export interface DshExportBuild {
  /** v3 头行。 */
  header: Record<string, unknown>;
  /** 事件行（seq 从 0 稠密，元素即 `{type, seq, time, data, surfaceOp?}`）。 */
  events: Array<Record<string, unknown>>;
  /** 降级/跳过说明（处理顺序，稳定可复现）。 */
  warnings: string[];
  /** 需要落盘的附件（图片块数，同一内容重复出现时由写入器去重）。 */
  attachmentWrites: DshExportAttachmentWrite[];
}

/** {@link writeDshSession} 的结果。 */
export interface DshExportResult {
  /** 新会话 id（= 目录名 = 头行 id）。 */
  sessionId: string;
  /** 会话目录绝对路径。 */
  dir: string;
  /** 会话文件绝对路径。 */
  file: string;
  /** 收集到的附件写入数（图片块数）。 */
  attachments: number;
  /** 降级/跳过说明。 */
  warnings: string[];
  /** 写出的事件条数。 */
  eventCount: number;
}

/** 未知 JSON 值取纯对象视图（数组/null/标量返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 事件 seq（缺省 -1；导出流由 deriveSessionRecords 保证稠密）。 */
function seqOf(event: Record<string, unknown>): number {
  return typeof event.seq === "number" ? event.seq : -1;
}

/** 事件 time（非数字时为 undefined；用于给追加事件挑一个合理时间）。 */
function timeOf(event: Record<string, unknown> | undefined): number | undefined {
  const time = event?.time;
  return typeof time === "number" && Number.isFinite(time) ? time : undefined;
}

/** 是否 surface 事件。 */
function isSurface(event: Record<string, unknown>): boolean {
  return typeof event.type === "string" && SURFACE_TYPES.includes(event.type);
}

/**
 * owc 消息里的图片块索引：键 = dsh 投影出的 `attachment.attachmentId`。
 *
 * 键格式（`<messageId>#<contentIndex>`）来自既有 wire 投影 `session-events.ts` 的 `toDshBlocks`：
 * 导出必须复用同一映射（不另写一套），因此这里按同一编号方案把 dsh 图片块回溯到 owc 原块，
 * 以便取回 base64 字节。前提是 owc 消息 id 唯一（与其投影本身的前提一致）。
 */
function imageSourceIndex(messages: readonly ChatMessage[]): Map<string, ImageContent> {
  const index = new Map<string, ImageContent>();
  for (const message of messages) {
    message.content.forEach((block, position) => {
      if (block.type === "image") index.set(`${message.id}#${position}`, block);
    });
  }
  return index;
}

/** 事件里承载内容块的容器：`user/message` 在 data 上，assistant/tool 在 `data.message` 上。 */
function contentOwner(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(event.data);
  if (data === undefined) return undefined;
  if (event.type === "assistant/message" || event.type === "tool/result") return asRecord(data.message);
  return data;
}

/**
 * 单个 dsh 图片块 → 内容寻址附件块（无法内联时降级为占位文本）。
 * @returns 改写后的块（新对象；永不返回 undefined）。
 */
function rewriteImageBlock(
  block: Record<string, unknown>,
  event: Record<string, unknown>,
  sources: Map<string, ImageContent>,
  writes: DshExportAttachmentWrite[],
  warnings: string[],
): Record<string, unknown> {
  const attachment = asRecord(block.attachment);
  const projectedId = typeof attachment?.attachmentId === "string" ? attachment.attachmentId : undefined;
  const where = `seq ${seqOf(event)} ${String(event.type)} 的图片块`;
  const source = projectedId === undefined ? undefined : sources.get(projectedId);
  if (source === undefined) {
    warnings.push(`${where} 找不到对应的 owc 图片块（投影 id ${projectedId ?? "?"}），导出为占位文本 ${OWC_IMAGE_PLACEHOLDER}`);
    return { type: "text", text: OWC_IMAGE_PLACEHOLDER };
  }
  const data = source.data;
  if (typeof data !== "string" || data.length === 0) {
    // owc 图片两种形态：data（内联 base64）/ ref（sessionDir 相对落盘路径）。
    // 纯函数不读盘（落盘引用由调用方在传入前内联为 data，计划决策⑤），因此 ref 只能占位。
    warnings.push(`${where} 仅有落盘引用（ref），未内联字节，导出为占位文本 ${OWC_IMAGE_PLACEHOLDER}`);
    return { type: "text", text: OWC_IMAGE_PLACEHOLDER };
  }
  const bytes = Buffer.from(data, "base64");
  const mediaType = imageMediaType(bytes);
  const dimensions = imageSize(bytes);
  if (bytes.byteLength === 0 || mediaType === undefined || dimensions === undefined) {
    warnings.push(`${where} 字节无法解析（空字节或非 PNG/GIF/JPEG/WebP），导出为占位文本 ${OWC_IMAGE_PLACEHOLDER}`);
    return { type: "text", text: OWC_IMAGE_PLACEHOLDER };
  }
  const attachmentId = createHash("sha256").update(bytes).digest("hex");
  const rewritten: Record<string, unknown> = {
    type: "image",
    attachment: {
      attachmentId,
      mediaType,
      bytes: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
  writes.push({ bytes, block: rewritten });
  return rewritten;
}

/** 把一个事件里的图片块全部改写成附件引用（原地改写新派生事件；附件只收集不落地）。 */
function rewriteEventImages(
  event: Record<string, unknown>,
  sources: Map<string, ImageContent>,
  writes: DshExportAttachmentWrite[],
  warnings: string[],
): void {
  const owner = contentOwner(event);
  const content = owner?.content;
  if (owner === undefined || !Array.isArray(content)) return;
  owner.content = content.map((raw) => {
    const block = asRecord(raw);
    if (block === undefined || block.type !== "image") return raw;
    return rewriteImageBlock(block, event, sources, writes, warnings);
  });
}

/**
 * 取首个 `user/message` 事件的 seq（`session/title.messageSeqs` 只能引用更早的人类用户消息）。
 * @returns 事件 seq；没有用户消息时 undefined。
 */
function firstUserMessageSeq(events: readonly Record<string, unknown>[]): number | undefined {
  for (const event of events) {
    if (event.type === "user/message") return seqOf(event);
  }
  return undefined;
}

/**
 * 工具生命周期重排：把每条 assistant 消息的 `assistant/message` 挪到它自己的 `tool/call`* **之前**。
 *
 * 依据：dsh v0→v1 关系校验（`relationships.ts` 的 `tool/call` 分支）要求调用先被
 * `assistant/message` 的 `tool-call` 块「广告」（同 callId、同名、同 arguments 字符串），
 * 而 wire 投影 {@link deriveSessionRecords} 为实时客户端把 `tool/call` 排在前面（wire 语义冻结，不改）。
 * 因此导出侧做一次纯搬运：**只在一组内换位**，不改任何事件内容、也不跨越 step/turn 边界。
 *
 * 组边界（与 {@link deriveSessionRecords} 的推送顺序严格一致）：一条 assistant 消息携带 k 个
 * `tool_call` 块时，它的事件恰好占 `[messageStarts[i], messageStarts[i] + k + 1)`，末条是
 * `assistant/message`。搬运前逐条校验形状（类型 + callId 一一对应），不匹配就保持原样不猜。
 */
function reorderAssistantToolCalls(
  events: Array<Record<string, unknown>>,
  messages: readonly ChatMessage[],
  messageStarts: readonly number[],
): void {
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const calls = message.content.filter((block) => block.type === "tool_call");
    if (calls.length === 0) return;
    const start = messageStarts[index];
    if (start === undefined) return;
    const assistantIndex = start + calls.length;
    if (events[assistantIndex]?.type !== "assistant/message") return;
    for (const [offset, call] of calls.entries()) {
      const event = events[start + offset];
      if (event?.type !== "tool/call" || asRecord(event.data)?.callId !== call.id) return;
    }
    // 全部校验通过后才搬动（避免半移动的中间态）
    const group = events.slice(start, assistantIndex + 1);
    events.splice(start, group.length, group[group.length - 1]!, ...group.slice(0, -1));
  });
}

/** 稠密重编 seq：重排后事件的 `seq` 必须回到「下标即 seq」（dsh 的事件坐标与数组下标严格一致）。 */
function renumberSeq(events: Array<Record<string, unknown>>): void {
  events.forEach((event, index) => {
    event.seq = index;
  });
}

/**
 * 找压缩锚点（最后一条被压缩消息）的下标。
 * 优先按 `uptoMessageId` 定位（id 不在列表 → 放弃）；缺省回退 `uptoIndex - 1`（`messages[0..uptoIndex)` 语义）。
 * @returns 消息下标；找不到时 undefined（并记 warning）。
 */
function compactionAnchor(messages: readonly ChatMessage[], compacted: DshExportLedgerCompacted, warnings: string[]): number | undefined {
  if (compacted.uptoMessageId !== undefined && compacted.uptoMessageId.length > 0) {
    const index = messages.findIndex((message) => message.id === compacted.uptoMessageId);
    if (index < 0) {
      warnings.push(`压缩锚点消息 ${compacted.uptoMessageId} 不在导出消息列表里，放弃压缩导出`);
      return undefined;
    }
    return index;
  }
  const index = compacted.uptoIndex - 1;
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
    warnings.push(`压缩锚点 uptoIndex=${compacted.uptoIndex} 超出消息范围（0..${messages.length - 1}），放弃压缩导出`);
    return undefined;
  }
  return index;
}

/**
 * 压缩导出：按 dsh 的压缩生命周期追加
 * `compaction/start` → `compaction/summary` → checkpoint `user/message`（replace 被压缩历史）→ `compaction/end`。
 *
 * seq 口径（重排 + 稠密重编之后计算）：当前 surface = 全部 `user/message`/`assistant/message`/`tool/result`
 * 的 seq 列表（此时它们都是 append）；被压缩前缀 span：`start` = 首个 surface seq、
 * `end` = 锚点消息最后一条 surface 事件的 seq；`shadowedSeqs` = 该 span 在 surface 上的连续切片
 * （= 按序的全部被压缩 surface seq），`shadowedRange` = `{start, end}`，checkpoint 的
 * `surfaceOp` 端点与 `sourceEventSeqs` 取同一组值；追加事件在文件尾部，replace 端点天然严格更早。
 *
 * 顺序（dsh 关系校验要求）：`compaction/start` → `compaction/summary` → checkpoint `user/message` → `compaction/end`；
 * summary 必须在 checkpoint 改写 surface **之前**发出，整段又必须在末轮 `turn/end` 之后（`turn: null`，无 open turn）。
 *
 * 放弃条件（各记一条 warning）：锚点找不到；锚点消息没有事件；被压缩区间里没有 surface 事件；
 * 导出流里存在受保护 `system/message` head（本模块不产生，仅作防御）；
 * 会话缺少 meta.provider/model（填 "unknown" 占位）。
 */
function appendCompaction(
  input: DshExportInput,
  events: Array<Record<string, unknown>>,
  messageStarts: readonly number[],
  sessionId: string,
  warnings: string[],
): void {
  const compacted = input.ledger?.compacted;
  if (compacted === undefined) return;
  const anchor = compactionAnchor(input.messages, compacted, warnings);
  if (anchor === undefined) return;
  const start = messageStarts[anchor];
  if (start === undefined) {
    warnings.push(`压缩锚点消息 ${input.messages[anchor]?.id ?? anchor} 没有派生事件，放弃压缩导出`);
    return;
  }
  // 锚点消息所在组的末尾：下一条消息的起始记录之前（末条消息到文件末尾）——
  // deriveSessionRecords 会在下一条用户消息前补 step/end + turn/end，它们属于被压缩的这一段。
  const groupEnd = (messageStarts[anchor + 1] ?? events.length) - 1;
  if (groupEnd < start) {
    warnings.push("压缩锚点区间为空，放弃压缩导出");
    return;
  }
  // 受保护 system head 守卫：本模块不产生 system/message（dsh 天然满足），这里只防未来回归。
  if (events.some((event) => event.type === "system/message")) {
    warnings.push("导出流里存在受保护的 system/message head，压缩导出的 replace 区间会遮蔽它，放弃压缩导出");
    return;
  }
  const surface = events.filter(isSurface).map(seqOf);
  const spanEnd = events.slice(start, groupEnd + 1).filter(isSurface).map(seqOf).at(-1);
  const surfaceStart = surface[0];
  if (surfaceStart === undefined || spanEnd === undefined) {
    warnings.push("被压缩区间内没有 surface 事件，放弃压缩导出（shadowedSeqs 不能为空）");
    return;
  }
  // shadowedSeqs 必须**恰好**是当前 surface 的连续一段（dsh 的 assertCurrentSurfaceSpan）。
  const shadowedSeqs = surface.slice(surface.indexOf(surfaceStart), surface.indexOf(spanEnd) + 1);
  const provider = input.meta.provider?.trim() ?? "";
  const model = input.meta.model?.trim() ?? "";
  if (provider.length === 0 || model.length === 0) {
    warnings.push(`会话缺少 meta.provider/model，compaction/summary 的归属字段按 dsh 要求填 ${UNKNOWN_ATTRIBUTION} 占位`);
  }
  const compactionId = `owc-compaction-${sessionId}`;
  const time = Date.parse(compacted.createdAt ?? "") || timeOf(events[groupEnd]) || timeOf(events[0]) || Date.now();
  // 1) compaction/start：turn=null 形态（必须在末轮 turn/end 之后、无 open turn 时发出）
  events.push({ type: "compaction/start", seq: events.length, time, data: { compactionId, turn: null } });
  // 2) compaction/summary：必须在 checkpoint 改写 surface 之前发出
  events.push({
    type: "compaction/summary",
    seq: events.length,
    time,
    data: {
      compactionId,
      summary: [{ type: "text", text: compacted.summary }],
      shadowedRange: { start: surfaceStart, end: spanEnd },
      shadowedSeqs,
      // owc 账本不记 token 数：dsh 只要求非负整数，如实填 0 而不是编造估算。
      shadowedTokenCount: 0,
      provider: provider.length === 0 ? UNKNOWN_ATTRIBUTION : provider,
      model: model.length === 0 ? UNKNOWN_ATTRIBUTION : model,
    },
  });
  // 3) checkpoint：user/message + replace（plugin==='compact' 才允许带 compactionId）
  events.push({
    type: "user/message",
    seq: events.length,
    time,
    data: {
      id: compactionId,
      role: "user",
      content: [{ type: "text", text: compacted.summary }],
      source: { kind: "plugin", plugin: COMPACTION_PLUGIN_NAME, compactionId },
    },
    surfaceOp: { op: "replace", startSeq: surfaceStart, endSeq: spanEnd },
    sourceEventSeqs: shadowedSeqs,
  });
  // 4) compaction/end：成功收尾要求已有过一次 summary
  events.push({ type: "compaction/end", seq: events.length, time, data: { compactionId, turn: null } });
}

/**
 * 由 owc 会话派生出 dsh v3 头行与事件流（**纯函数**：不落盘、不改写入参）。
 *
 * 事件主体 = {@link deriveSessionRecords}(messages) 的 records 剥壳（time 取消息 createdAt 毫秒），
 * 其上叠加四件事：工具生命周期重排（`assistant/message` 先于 `tool/call`，随后稠密重编 seq）、
 * 图片块 → 内容寻址附件引用、`session/title`（meta.title 非空时）、压缩导出（`compaction/*` + checkpoint）。
 * 重排必须发生在图片改写与标题/压缩之前：后两者的 seq 引用都按重排后的口径计算。
 * @param input - 导出输入（`cwd` 必须绝对路径）。
 * @param sessionId - 本次导出的会话 id（由 {@link writeDshSession} 生成）。
 * @returns 头行 + 事件 + 警告 + 待写附件（附件字节已在内存里，`writeDshSession` 负责落地）。
 */
export function buildDshSessionEvents(input: DshExportInput, sessionId: string): DshExportBuild {
  if (!path.isAbsolute(input.cwd)) {
    throw new Error(`导出会话的 cwd 必须是绝对路径：${input.cwd}`);
  }
  if (input.subagent !== undefined && input.subagent.parentSession.trim().length === 0) {
    throw new Error("子代理会话的 parentSession 不能为空");
  }
  const warnings: string[] = [];
  const provider = input.meta.provider ?? "";
  const model = input.meta.model ?? "";
  const { records, messageStarts } = deriveSessionRecords(input.messages, { provider, model });
  const events: Array<Record<string, unknown>> = records.map((record) => record.event as Record<string, unknown>);
  reorderAssistantToolCalls(events, input.messages, messageStarts);
  renumberSeq(events);
  const createdAt = Date.parse(input.meta.createdAt ?? "") || Date.now();
  if (provider.length === 0 || model.length === 0) {
    // 只在确实有 assistant 消息时提醒：dsh 加载校验要求模型归属非空，空串会被拒。
    if (input.messages.some((message) => message.role === "assistant")) {
      warnings.push("未提供 meta.provider/model：assistant 事件的 source.provider/model 为空串，dsh 侧加载时可能拒绝该会话");
    }
  }
  const header: Record<string, unknown> = {
    type: "session",
    version: DSH_SYNC_SUPPORTED_GENERATION,
    id: sessionId,
    createdAt,
    isSeeded: false,
    // M5a：子代理会话的头行（dsh 侧 origin/parentSession/delegationDepth 三件套必须同时给出）
    delegationDepth: input.subagent === undefined ? 0 : 1,
    cwd: input.cwd,
    ...(input.subagent === undefined ? {} : {
      origin: "subagent",
      parentSession: input.subagent.parentSession,
      ...(input.subagent.agentPreset === undefined || input.subagent.agentPreset.length === 0
        ? {}
        : { agentPreset: input.subagent.agentPreset }),
    }),
  };

  // 1) 图片块 → 附件引用（同一内容多次出现时 writeDshAttachment 幂等去重）
  const sources = imageSourceIndex(input.messages);
  const attachmentWrites: DshExportAttachmentWrite[] = [];
  for (const event of events) rewriteEventImages(event, sources, attachmentWrites, warnings);

  // 2) 标题（dsh 头行没有 title 字段；标题是 session/title 事件，messageSeqs 必须引用更早的 user/message）
  const title = input.meta.title?.trim() ?? "";
  if (title.length > 0) {
    const titleSeq = firstUserMessageSeq(events);
    if (titleSeq === undefined) {
      warnings.push("会话没有用户消息，无法导出标题（dsh 的 session/title 必须引用更早的 user/message 事件）");
    } else {
      events.push({
        type: "session/title",
        seq: events.length,
        time: timeOf(events[titleSeq]) ?? createdAt,
        data: { title: title.slice(0, TITLE_MAX_LENGTH), messageSeqs: [titleSeq], source: { kind: "fallback" } },
      });
    }
  }

  // 3) 压缩导出
  appendCompaction(input, events, messageStarts, sessionId, warnings);
  return { header, events, warnings, attachmentWrites };
}

/** 压缩一帧（dsh 同参数：带校验和；逐帧独立可解）。 */
function zstdFrame(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"), ZSTD_CHECKSUM_OPTIONS);
}

/**
 * 封装 v3 文件字节：头行单独一帧（dsh 要求首帧恰好一行头），事件整体一帧（导出一批即可）。
 * 每行都以 `\n` 结束（dsh 的行扫描要求完整记录）。
 */
function encodeSessionFrames(header: Record<string, unknown>, events: readonly Record<string, unknown>[]): Buffer {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error("当前 Node 运行时缺少 zstd 压缩能力（需要 Node 22.15+），无法写出 dsh v3 会话");
  }
  const frames = [zstdFrame(`${JSON.stringify(header)}\n`)];
  if (events.length > 0) frames.push(zstdFrame(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`));
  return Buffer.concat(frames);
}

/** 路径是否存在（不区分文件/目录）。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写字节：唯一临时文件（0600）+ rename（dsh 自身的会话落盘同款：先写临时再发布）。
 * 新建文件不会与"目标已存在"的读窗口冲突，因此不需要 Windows 重试循环。
 */
async function writeBinaryAtomically(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * 回读自检：解码刚写出的文件，校验头行、事件数与逐条内容一致。
 * `seq` 稠密与 zstd 帧完整性由 M1 的 {@link decodeDshSessionFile} 一并校验（不一致即抛错）。
 */
async function selfCheck(file: string, sessionId: string, built: DshExportBuild): Promise<void> {
  const decoded = await decodeDshSessionFile({
    file,
    generation: DSH_SYNC_SUPPORTED_GENERATION,
    compressed: true,
  });
  if (decoded.header.id !== sessionId) {
    throw new Error(`导出自检失败：回读头行 id=${String(decoded.header.id)} 与 ${sessionId} 不一致`);
  }
  if (decoded.header.version !== DSH_SYNC_SUPPORTED_GENERATION) {
    throw new Error(`导出自检失败：回读头行 version=${String(decoded.header.version)} 不是 v${DSH_SYNC_SUPPORTED_GENERATION}`);
  }
  if (decoded.events.length !== built.events.length) {
    throw new Error(`导出自检失败：回读到 ${decoded.events.length} 条事件，期望 ${built.events.length} 条`);
  }
  if (!isDeepStrictEqual(decoded.events, built.events)) {
    throw new Error("导出自检失败：回读事件与写出事件不一致");
  }
}

/**
 * 导出一个 dsh v3 会话（只新增目录，绝不覆盖已有会话）。
 *
 * 流程：目录已存在即拒绝 → mkdir -p → 附件内容寻址落盘 → 头帧 + 事件帧写 `session.v3.jsonl.zstd`
 * → 回读自检；任一步失败都删除本次新建的目录再把错误抛给调用方。
 * @param input - 导出输入（`cwd` 必须绝对路径）。
 * @param sessionId - 目标会话 id；缺省新生成一个 uuid（显式传入便于测试与「同一 id 冲突检测」）。
 * @returns 落盘结果（含降级警告）。
 */
export async function writeDshSession(input: DshExportInput, sessionId: string = randomUUID()): Promise<DshExportResult> {
  const built = buildDshSessionEvents(input, sessionId);
  const dir = dshSessionDir(input.dshHome, input.cwd, sessionId);
  if (await pathExists(dir)) {
    throw new Error(`会话目录已存在：${dir}（导出只新增，不覆盖已有会话）`);
  }
  const file = path.join(dir, SESSION_FILE_NAME);
  // dsh 自身用 0700 目录 / 0600 文件（上游 materializePosix），导出沿用同一权限口径。
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    for (const write of built.attachmentWrites) writeDshAttachment(input.dshHome, write.bytes);
    await writeBinaryAtomically(file, encodeSessionFrames(built.header, built.events));
    await selfCheck(file, sessionId, built);
  } catch (error: unknown) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    sessionId,
    dir,
    file,
    attachments: built.attachmentWrites.length,
    warnings: built.warnings,
    eventCount: built.events.length,
  };
}
