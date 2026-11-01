/**
 * dsh-sync 扩展 M4a：owc 会话 → dsh v3 会话文件（`session.v3.jsonl.zstd`）的写出器。
 *
 * 分工：
 * - {@link buildDshSessionEvents} 是**纯函数**：消息层预处理 → 派生事件 → 工具生命周期重排 + 事件关系修复 +
 *   稠密重编 seq → 改写图片块 → 追加标题与压缩生命周期，附件只收集不落地；
 * - {@link writeDshSession} 负责落盘（结构校验 + 内容寻址写附件 + zstd 帧 + 回读自检 + 失败清理）。
 *
 * 事件映射**复用**既有实现：`server/src/dsh/web-protocol/session-events.ts` 的 {@link deriveSessionRecords}
 * （owc → dsh 的 wire 投影），本模块只做它不负责的几件事：消息层预处理（孤儿/多结果 tool 消息）、
 * 图片附件化、工具生命周期重排、事件关系修复、结构校验、压缩导出、v3 文件封装。
 *
 * **导出方向的正确性约束**（owc 会话来路很杂：中断的回合、分叉/重试的离路径消息、外部导入的任意 JSONL）：
 * - 消息历史必须只取**活动路径**（调用方负责，见 `dsh-sync-host.ts` 的导出分支）：`sessions.get` 给的是
 *   全量消息表，直接导出会把「用户没发生过的对话」写进 dsh 会话；
 * - 每次导出都必须产出一份 dsh 官方校验器认可的会话，因此这里有**三道门**：消息层预处理（{@link preprocessExportMessages}）、
 *   事件层修复（{@link repairEventRelationships}）+ 重排后置不变量（{@link assertToolCallsAdvertised}）、
 *   写盘前结构校验（{@link validateDshEvents}）。前两道门能当场修好的就修好并记警告（丢弃/拆分/补事件），
 *   修不了或校验不过的**导出直接失败**——宁可不导出，也绝不写出一份 dsh 拒收的坏文件。
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
 *   未结算的工具调用只认一种「修复」形态：`tool/result` 带 `error:{name:'ToolNotStartedError',
 *   code:'TOOL_NOT_STARTED'}`、无 `sourceEventSeqs`、`message.id` 为
 *   `interrupted-tool-result-<callId>-<数字>`、内容恰好一个 `isError:true` 的结果包装块（逐字段与上游
 *   `isExactToolNotStartedRepair`/`isRepairIdentity`/`notStartedRepair` 一致）——导出器正是用它补齐
 *   「有广告没结果」的中断回合（见 {@link buildToolNotStartedRepair}）。
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
 *   （M5a 用它写子代理会话：`delegationDepth` + `parentSession` 父会话新 id + 可选 `agentPreset`；
 *   嵌套子代理逐层递增 delegationDepth）；
 * - `assistant/message.message.source` 允许额外键 `replayState`（llm-service-lite 的回放元数据；
 *   上游 v0→v1 payload 校验把 model source 的可选键显式列为 `replayState`，v3→v4 原样保留）
 *   ——本模块只在该会话 provider 的接口协议承载 replay 时按位写回（见 {@link replayStateFor}）。
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
import type { ChatMessage, ImageContent, MessageContent, ToolResultContent } from "../sessions/types.js";
import { DSH_SYNC_WRITE_GENERATION, decodeDshSessionFile, dshSessionDir, writeDshAttachment } from "./dsh-sync-dsh.js";
import { imageMediaType, imageSize } from "./dsh-sync-image-size.js";

/** dsh v3 会话文件名（写出代际固定为 v3，dsh 加载时自动迁移到当前代际）。 */
const SESSION_FILE_NAME = `session.v${DSH_SYNC_WRITE_GENERATION}.jsonl.zstd`;

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

/**
 * dsh 官方「工具未启动」修复（TOOL_NOT_STARTED）的三件套：错误名/码 + 唯一文本块文案。
 * 三处都必须逐字节与上游一致——`session-format-v0-to-v1` 的 `isExactToolNotStartedRepair` 与
 * `session-format-v2-to-v3` 的 `isRepairIdentity`、`session-format-v3-to-v4` 的 `notStartedRepair`
 * 都是精确匹配，差一个字符就被判「不是修复形态」而拒收。
 */
const TOOL_NOT_STARTED_ERROR_NAME = "ToolNotStartedError";
const TOOL_NOT_STARTED_ERROR_CODE = "TOOL_NOT_STARTED";
const TOOL_NOT_STARTED_TEXT = "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.";
/** 修复事件 message.id 的规范前缀（`interrupted-tool-result-<callId>-<seq>`）。 */
const TOOL_NOT_STARTED_MESSAGE_PREFIX = "interrupted-tool-result-";

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
   * 会话 provider 的接口类型映射（`owc provider id → interfaceType`）。
   *
   * llm-service-lite 的 `source.replayState` 是**协议私有**的回放元数据（anthropic-messages 写
   * `signature`/`redacted`，openai-responses 写 reasoning `item`）：只有知道该 provider 走哪套
   * 端点协议，才能把 owc thinking 块的签名按 dsh 读侧的按位口径写回去（见 {@link replayStateFor}）。
   * 缺省（或该 provider 不在表里）时一律不写 replayState，并如实告警「签名被丢弃」。
   */
  providerInterfaces?: Record<string, DshProviderInterfaceType>;
  /**
   * 子代理会话标记（M5a）：给出时头行写成 dsh 的子代理形态——
   * `origin:'subagent'` + `parentSession`（父会话的**新** dsh id）+ `delegationDepth`，
   * 可选的 `agentPreset` 即子代理 preset（来自 owc 转录的 `agent` 字段）。
   * `delegationDepth` 缺省 1（直接子会话）；嵌套子代理逐层递增（见 dsh-sync-host 的递归导出）。
   */
  subagent?: { parentSession: string; agentPreset?: string; delegationDepth?: number };
}

/**
 * 会话 provider 的端点协议（与 `provider-profiles.ts` 的 `ModelInterfaceType` 同词汇表）。
 * 只列 dsh 侧有 replay 元数据落点的两种「可写回」协议 + 一种明确不承载的 chat-completions。
 */
export type DshProviderInterfaceType = "anthropic-messages" | "openai-responses" | "openai-chat-completions";

/** llm-service-lite 的 replay 协议名（与上游 `REPLAY_KIND`/`RESPONSES_REPLAY_KIND` 逐字一致）。 */
const REPLAY_KIND_ANTHROPIC = "llm-service-lite-anthropic";
const REPLAY_KIND_RESPONSES = "llm-service-lite-responses";
/** replay 信封版本（上游 `REPLAY_VERSION`/`RESPONSES_REPLAY_VERSION` 当前均为 1）。 */
const REPLAY_VERSION = 1;

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

/** 取正整数（turn/step；非正整数时用缺省值）。 */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
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

/** 事件承载的内容块（只保留对象块；无内容时返回空数组）。 */
function contentBlocksOf(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = contentOwner(event)?.content;
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/** tool/result 事件的工具调用 id（`data.message.source.callId`；投影与合成的修复事件同口径）。 */
function toolResultCallId(event: Record<string, unknown>): string | undefined {
  const message = asRecord(asRecord(event.data)?.message);
  const callId = asRecord(message?.source)?.callId;
  return typeof callId === "string" && callId.length > 0 ? callId : undefined;
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
  return imageAttachmentBlock(source, where, writes, warnings).block;
}

/**
 * owc 图片块 → 内容寻址附件块（`image{attachment}`）；不可内联时返回占位文本块并记 warning。
 *
 * 两条调用路径共用本函数：顶层 `image` 块（按投影 id 回溯 owc 原块，见 {@link rewriteImageBlock}）与
 * tool_result 包装块内的 `media[]`（见 {@link rewriteEventImages}，那里直接拿到 owc 媒体块）。
 * @param source - owc 图片块（`data` 内联 base64 或 `ref` 落盘引用）。
 * @param where - 警告定位前缀。
 * @returns `block` = 改写后的块（attachment 已算好 sha256）；`inlined` = 是否真的内联成图片块
 *   （false 表示返回的是占位文本，原因已进 warnings）。
 */
function imageAttachmentBlock(
  source: ImageContent,
  where: string,
  writes: DshExportAttachmentWrite[],
  warnings: string[],
): { block: Record<string, unknown>; inlined: boolean } {
  const data = source.data;
  if (typeof data !== "string" || data.length === 0) {
    // owc 图片两种形态：data（内联 base64）/ ref（sessionDir 相对落盘路径）。
    // 纯函数不读盘（落盘引用由调用方在传入前内联为 data，计划决策⑤），因此 ref 只能占位。
    warnings.push(`${where} 仅有落盘引用（ref），未内联字节，导出为占位文本 ${OWC_IMAGE_PLACEHOLDER}`);
    return { block: { type: "text", text: OWC_IMAGE_PLACEHOLDER }, inlined: false };
  }
  const bytes = Buffer.from(data, "base64");
  const mediaType = imageMediaType(bytes);
  const dimensions = imageSize(bytes);
  if (bytes.byteLength === 0 || mediaType === undefined || dimensions === undefined) {
    warnings.push(`${where} 字节无法解析（空字节或非 PNG/GIF/JPEG/WebP），导出为占位文本 ${OWC_IMAGE_PLACEHOLDER}`);
    return { block: { type: "text", text: OWC_IMAGE_PLACEHOLDER }, inlined: false };
  }
  const attachmentId = createHash("sha256").update(bytes).digest("hex");
  const block: Record<string, unknown> = {
    type: "image",
    attachment: {
      attachmentId,
      mediaType,
      bytes: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
  writes.push({ bytes, block });
  return { block, inlined: true };
}

/**
 * 工具结果携带的媒体索引：键 = `toolCallId`（一次调用的结果只有一条）。
 *
 * owc 的 `ToolResultContent.media`（read_media 等）在既有 wire 投影里**不产生任何 dsh 块**
 * （`session-events.ts::toDshBlocks` 的 tool_result 分支只取 `content` 文本），因此导出侧要自己
 * 把它补成 `image{attachment}` 块（见 {@link rewriteEventImages}）。这里按 callId 建索引取回字节：
 * callId 与 dsh tool-result 包装块的 `toolCallId` 同名，配对可靠（同一 callId 多处出现时合并）。
 */
function toolResultMediaIndex(messages: readonly ChatMessage[]): Map<string, ToolResultMedia> {
  const index = new Map<string, ToolResultMedia>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.media === undefined || block.media.length === 0) continue;
      index.set(block.toolCallId, [...(index.get(block.toolCallId) ?? []), ...block.media]);
    }
  }
  return index;
}

/** tool_result 携带的媒体块（图片可导出为 dsh 图片块，视频 dsh 无对应块）。 */
type ToolResultMedia = NonNullable<ToolResultContent["media"]>;

/**
 * 把一个事件里的图片改写成附件引用（原地改写新派生事件；附件只收集不落地）。
 *
 * 两个落点：
 * 1. 顶层 `image` 块（user/assistant 消息的图片）：既有 wire 投影已产出 image 块，按投影 id 回溯
 *    owc 原块取字节；
 * 2. `tool/result` 事件的 tool-result 包装块内的 `media[]`（owc `ToolResultContent.media`）：投影
 *    **不产出任何块**，因此在包装块的 `content` 数组尾部补 `image{attachment}` 块。补进去的图片是
 *    结果内容的一部分（dsh v3 的 tool-result 子块允许 image，v4 迁移原样提升为一等 tool 消息的
 *    content 块），可读才补、不可读记 warning 后跳过（不伪造占位文本：那会把工具结果正文改成一句
 *    「这里曾有一张图」，而结果正文本身已经导出）。dsh 没有视频块，视频如实告警后跳过。
 */
function rewriteEventImages(
  event: Record<string, unknown>,
  sources: Map<string, ImageContent>,
  media: Map<string, ToolResultMedia>,
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
  if (event.type !== "tool/result") return;
  const callId = toolResultCallId(event);
  const carried = callId === undefined ? undefined : media.get(callId);
  if (carried === undefined || carried.length === 0) return;
  const wrapper = contentBlocksOf(event)[0];
  const inner = wrapper?.type === "tool-result" && Array.isArray(wrapper.content) ? wrapper.content as unknown[] : undefined;
  if (wrapper === undefined || inner === undefined) return;
  const where = `seq ${seqOf(event)} tool/result 的 tool_result.media[]`;
  for (const [position, item] of carried.entries()) {
    if (item.type !== "image") {
      warnings.push(`${where} 第 ${position + 1} 个媒体块是视频（${item.mediaType}）：dsh 无视频内容块，已跳过`);
      continue;
    }
    const { block, inlined } = imageAttachmentBlock(item, `${where} 第 ${position + 1} 张图`, writes, warnings);
    if (inlined) inner.push(block);
  }
}

// ── assistant 消息的 replay 元数据（thinking signature/redacted 写回 dsh） ─────────

/** {@link replayStateFor} 的产物。 */
interface ReplayStateBuild {
  /** 要写进 `message.source.replayState` 的信封；不写时为 undefined。 */
  state?: Record<string, unknown>;
  /** 被丢弃的回放字段名（`signature`/`redacted`）；空数组 = 一个都没丢（调用方据此决定要不要告警）。 */
  dropped: string[];
  /** 丢弃原因（`dropped` 非空时给出）。 */
  reason?: string;
}

/**
 * responses 协议 text 块签名里的 item id：`{v:1,id,phase?}` 的 `id`。
 * 签名非法/缺 id 时 undefined（回放端会退回正文重建，不阻断导出）。
 */
function textItemIdOf(textSignature: string | undefined): string | undefined {
  if (textSignature === undefined || textSignature.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(textSignature);
  } catch {
    return undefined;
  }
  const id = asRecord(parsed)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * assistant 消息的 owc 内容块 → llm-service-lite 的 `source.replayState`（以会话 provider 的接口协议为准）。
 *
 * 为什么必须按位：dsh 的 `replayBlocksOf`（anthropic-messages / openai-responses 两侧同款校验）要求
 * `replayState.blocks.length === message.content.length` 且第 i 项 `type` 与内容块 `type` 逐位相同
 * （text/reasoning/tool-call），任何错位都让整条消息退化为「provider 中立历史」——写了等于没写。
 * 因此这里的 blocks 与**投影后的** dsh 内容块一一对应（`toDshBlocks` 不投影 video/web_search_call
 * 等块，这里同样跳过；image/tool-result 有 dsh 块但 replay 词表没有对应项 → 整条不回放并告警）。
 *
 * 字段落点（与 owc `sessions/types.ts` 的持久化口径一致）：
 * - anthropic-messages：`{type:'reasoning', signature?, redacted?}` 直接取 thinking 块的同名字段；
 * - openai-responses：`{type:'reasoning', item}` 取 thinking.`signature`（owc 对该协议把完整 reasoning
 *   item JSON 存在 signature）、`{type:'text'|'tool-call', itemId?}` 取 textSignature 的 id / tool_call.itemId；
 * - openai-chat-completions（或没有接口类型信息）：dsh 侧没有 replay 落点，一律不写并如实计入 dropped。
 * @param content - assistant 消息的内容块。
 * @param interfaceType - 该会话 provider 的接口类型；未知时 undefined。
 * @returns 信封（可写时）+ 被丢弃字段名 + 原因。
 */
function replayStateFor(
  content: readonly MessageContent[],
  interfaceType: DshProviderInterfaceType | undefined,
): ReplayStateBuild {
  const fieldNames = (block: MessageContent): string[] => block.type !== "thinking"
    ? []
    : [...(block.signature === undefined ? [] : ["signature"]), ...(block.redacted === undefined ? [] : ["redacted"])];
  /** 该协议**自己**的 replay 字段：anthropic 看签名/密文，responses 还看 itemId/textSignature。 */
  const relevant = () => {
    if (interfaceType === "anthropic-messages") {
      return content.some((block) => block.type === "thinking" && (block.signature !== undefined || block.redacted !== undefined));
    }
    if (interfaceType === "openai-responses") {
      return content.some((block) => (block.type === "thinking" && block.signature !== undefined)
        || (block.type === "text" && block.textSignature !== undefined)
        || (block.type === "tool_call" && block.itemId !== undefined));
    }
    // 协议未知/不承载：以「有没有会被丢掉的回放字段」为准（没有就不写也不告警）
    return content.some((block) => block.type === "thinking" && (block.signature !== undefined || block.redacted !== undefined));
  };
  if (!relevant()) return { dropped: [] };
  const present = content.flatMap(fieldNames);

  if (interfaceType !== "anthropic-messages" && interfaceType !== "openai-responses") {
    return {
      dropped: present,
      reason: `会话 provider 的接口协议（${interfaceType ?? "未知"}）在 dsh 侧没有 replay 元数据落点`,
    };
  }
  // 非投影块（video/web_search_call 等）不占 dsh 内容位，跳过不影响按位对齐；
  // image/tool-result 会占位但 replay 词表没有对应项 → 整条消息放弃回放元数据。
  const misaligned = content.find((block) => block.type === "image" || block.type === "tool_result");
  if (misaligned !== undefined) {
    return {
      dropped: present,
      reason: `消息含 ${misaligned.type} 内容块（dsh 的 replayState 词表只有 text/reasoning/tool-call），无法按位对齐`,
    };
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    switch (block.type) {
      case "text": {
        if (interfaceType === "anthropic-messages") blocks.push({ type: "text" });
        else {
          const itemId = textItemIdOf(block.textSignature);
          blocks.push({ type: "text", ...(itemId === undefined ? {} : { itemId }) });
        }
        break;
      }
      case "thinking": {
        if (interfaceType === "anthropic-messages") {
          blocks.push({
            type: "reasoning",
            ...(block.signature === undefined ? {} : { signature: block.signature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
          });
        } else {
          blocks.push({ type: "reasoning", ...(block.signature === undefined ? {} : { item: block.signature }) });
        }
        break;
      }
      case "tool_call": {
        if (interfaceType === "anthropic-messages") blocks.push({ type: "tool-call" });
        else blocks.push({ type: "tool-call", ...(block.itemId === undefined ? {} : { itemId: block.itemId }) });
        break;
      }
      default:
        // video/web_search_call 等：投影不产出 dsh 内容块，这里也不占位（保持按位对齐）
        break;
    }
  }
  if (blocks.length === 0) return { dropped: present };
  // responses 只承载 reasoning item（thinking.signature）：redacted 密文没有落点，如实计入丢弃。
  const dropped = interfaceType === "openai-responses"
    ? content.flatMap((block) => block.type === "thinking" && block.redacted !== undefined ? ["redacted"] : [])
    : [];
  return {
    state: {
      response: {
        kind: interfaceType === "anthropic-messages" ? REPLAY_KIND_ANTHROPIC : REPLAY_KIND_RESPONSES,
        version: REPLAY_VERSION,
      },
      blocks,
    },
    dropped,
    ...(dropped.length === 0 ? {} : { reason: "openai-responses 的 replay 只承载 reasoning item（thinking.signature），redacted 密文没有落点" }),
  };
}

/**
 * 给 assistant 事件补写 `source.replayState`（逐条按消息 id 回溯 owc 原消息取内容块口径）。
 *
 * 只在会话 provider 的接口类型已知且承载 replay 时写；被丢弃的 signature/redacted 一律告警
 * （这些字段丢了，dsh 侧该轮思考内容无法原样回放——属于用户能感知的降级，不能静默）。
 * @param events - 已派生（且已重排/重编号）的事件流（原地改写 `data.message.source`）。
 * @param messages - 预处理后的 owc 消息列表（assistant 消息未被预处理改动）。
 * @param interfaceType - 会话 provider 的接口类型。
 * @param warnings - 降级说明。
 */
function applyReplayState(
  events: readonly Record<string, unknown>[],
  messages: readonly ChatMessage[],
  interfaceType: DshProviderInterfaceType | undefined,
  warnings: string[],
): void {
  const byId = new Map(messages.filter((message) => message.role === "assistant").map((message) => [message.id, message]));
  if (byId.size === 0) return;
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const message = asRecord(asRecord(event.data)?.message);
    const id = message?.id;
    if (message === undefined || typeof id !== "string") continue;
    const source = byId.get(id);
    if (source === undefined) continue;
    const built = replayStateFor(source.content, interfaceType);
    const messageSource = asRecord(message.source);
    if (built.state !== undefined && messageSource !== undefined) messageSource.replayState = built.state;
    if (built.dropped.length > 0) {
      warnings.push(`消息 ${id} 的 thinking 回放元数据 ${built.dropped.join("、")} 未导出：${built.reason ?? "该协议不承载"}（dsh 侧回放这一轮时思考内容会退化）`);
    }
  }
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
 * 消息层预处理（在 {@link deriveSessionRecords} 之前）：把 owc 历史整理成 dsh 能表达的形态。
 *
 * dsh 的 `tool/result` 事件要求：message **恰好**带一个 `tool-result` 包装块、`toolCallId` 与
 * `source.callId` 一致，且该 callId 的生命周期（由同 step 的 `assistant/message` 广告）能在本 step
 * 内结算（v4 `liftToolResult` / `tool-role.ts`，以及 v0→v1 `relationships.ts`）。因此这一层做四件事
 * （都记 warning，不静默）：
 * 1. **孤儿 `tool_result` 块**（callId 没有在此前任何 assistant 消息的 tool_call 集合里出现过，例如
 *    `!cmd` 直写路径）→ 丢弃（dsh 拒收：`tool/result ... has no advertised tool lifecycle`）；
 * 2. **跨 turn 的迟到结果**（callId 是在**更早的回合**广告的：dsh 的 tool/result 必须与广告同 step，
 *    晚到的结果无法结算）→ 丢弃。真实会话里这就是「回合被中断、结果在下一轮才补写」的形态
 *    （owc 补写的正文是 `The run was interrupted before this tool finished…`），丢弃后由事件层的
 *    「工具未启动」修复事件如实表达同一件事（见 {@link repairEventRelationships}）；
 * 3. **重复结果**（同一 callId 在本回合已结算过）→ 丢弃；
 * 4. **一条 tool 消息含 ≥2 个 `tool_result` 块** → 拆成 N 条单块 tool 消息（保持相对顺序，id 各派生
 *    `<原id>-<i>`）；tool 消息里非 `tool_result` 的兄弟块（text/image 等）会破坏「恰好一个包装块」→ 丢弃。
 * 块丢光（或整条消息没有任何 tool_result）则整条消息丢弃。
 *
 * 不变量：返回列表里每条 tool 消息都恰好带一个 `tool_result` 块，且该块能在**同一回合**内抵消一条
 * 尚未结算的广告（顺序敏感，见下）；assistant 消息原样保留（其 tool_call 集合是「广告」的唯一来源）。
 * @param messages - owc 消息历史（**活动路径**由调用方先过滤好，见 dsh-sync-host 导出分支）。
 * @param warnings - 丢弃/拆分说明（处理顺序，稳定可复现）。
 * @returns 新的消息列表（不改写入参；无需改动的消息原样复用）。
 */
function preprocessExportMessages(messages: readonly ChatMessage[], warnings: string[]): ChatMessage[] {
  /**
   * 未结算的广告：callId → { 广告所在回合, 未结算条数 }。
   * 计数而非布尔值是必要的：同一 callId 可以「结算 → 重新广告 → 再结算」（上游在结算时会删掉生命周期，
   * 之后重新广告是合法的），只有按顺序一对一抵消才能既保住合法结果、又把真重复判出来。
   */
  const pending = new Map<string, { turn: number; count: number }>();
  const processed: ChatMessage[] = [];
  let turn = 0;
  let droppedSiblings = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      processed.push(message);
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        const entry = pending.get(block.id);
        if (entry === undefined) pending.set(block.id, { turn, count: 1 });
        else {
          // 同 callId 重复广告：计数（上游会判 repeats advertised tool call，由结构校验兜底）
          entry.turn = turn;
          entry.count += 1;
        }
      }
      processed.push(message);
      continue;
    }
    if (message.role !== "tool") {
      processed.push(message);
      continue;
    }
    const results = message.content.filter((block): block is ToolResultContent => block.type === "tool_result");
    const siblings = message.content.filter((block) => block.type !== "tool_result");
    let orphans = 0;
    let late = 0;
    let duplicates = 0;
    const kept: ToolResultContent[] = [];
    for (const block of results) {
      const entry = pending.get(block.toolCallId);
      if (entry === undefined) {
        orphans += 1;
        continue;
      }
      if (entry.turn !== turn) {
        late += 1;
        continue;
      }
      if (entry.count === 0) {
        duplicates += 1;
        continue;
      }
      entry.count -= 1;
      kept.push(block);
    }
    if (orphans + late + duplicates > 0) {
      const reasons = [
        ...(orphans === 0 ? [] : [`${orphans} 个孤儿结果（没有先行广告的 tool_call）`]),
        ...(late === 0 ? [] : [`${late} 个跨回合的迟到结果（dsh 的 tool/result 必须与广告同 step，无法结算）`]),
        ...(duplicates === 0 ? [] : [`${duplicates} 个重复结果（同一 callId 在本回合已结算过）`]),
      ];
      warnings.push(`消息 ${message.id} 丢弃了 ${reasons.join("、")}`);
    }
    if (kept.length === 0) {
      warnings.push(results.length === 0
        ? `消息 ${message.id} 是 tool 角色但没有 tool_result 块（dsh 的 tool/result 事件必须带一个结果），整条消息不再导出`
        : `消息 ${message.id} 的 tool_result 块全部被上一条丢弃，整条消息不再导出`);
      continue;
    }
    droppedSiblings += siblings.length;
    if (kept.length === 1 && results.length === 1 && siblings.length === 0) {
      // 常见路径：单结果 tool 消息原样保留（id 不变，压缩锚点仍能定位）
      processed.push(message);
      continue;
    }
    if (kept.length === 1) {
      // 只是丢了孤儿/迟到/重复块或兄弟块：保留原 id，内容收敛为唯一结果块
      processed.push({ ...message, content: [kept[0]!] });
      continue;
    }
    kept.forEach((block, index) => {
      processed.push({ ...message, id: `${message.id}-${index}`, content: [block] });
    });
    warnings.push(`消息 ${message.id} 含 ${kept.length} 个 tool_result 块（dsh 一条 tool/result 只能带一个结果块），已拆成 ${kept.length} 条单块消息`);
  }
  if (droppedSiblings > 0) {
    warnings.push(`tool 消息里有 ${droppedSiblings} 个非 tool_result 内容块（dsh 的 tool/result 事件只表达一个结果块），已丢弃`);
  }
  return processed;
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

// ── 导出方向的正确性门：事件层修复 + 后置不变量 + 写盘前结构校验 ──────────────────

/**
 * 在 events 的 index 处插入若干事件，并同步平移 messageStarts。
 *
 * messageStarts 是「消息下标 → 该消息首条事件下标」的映射（deriveSessionRecords 的产物），
 * 压缩导出靠它定位锚点消息的事件区间；插入事件后不平移就会用到错的区间。
 */
function spliceEvents(
  events: Array<Record<string, unknown>>,
  index: number,
  inserted: readonly Record<string, unknown>[],
  messageStarts: number[],
): void {
  if (inserted.length === 0) return;
  events.splice(index, 0, ...inserted);
  for (let position = 0; position < messageStarts.length; position += 1) {
    const start = messageStarts[position];
    if (start !== undefined && start >= index) messageStarts[position] = start + inserted.length;
  }
}

/** 合成的事件：`message.id` 依赖**最终** seq，因此先插入占位、稠密重编 seq 之后再回填。 */
interface PendingRepairEvent {
  /** 合成的事件对象（已插入 events 里）。 */
  event: Record<string, unknown>;
  /** 未结算的工具调用 id（回填 `message.id` 用）。 */
  callId: string;
}

/** 找 from 之后第一条 `step/end` 的下标（-1 = 没有）。 */
function findStepEnd(events: readonly Record<string, unknown>[], from: number): number {
  for (let index = from; index < events.length; index += 1) {
    if (events[index]?.type === "step/end") return index;
  }
  return -1;
}

/**
 * 收集一段事件区间内「已广告但未结算」的工具调用（保持广告顺序）。
 *
 * 语义与 dsh 的生命周期逐条对齐：`assistant/message` 的 tool-call 块登记广告，`tool/result` 结算并
 * 删除该广告（无论它是否已被 `tool/call` 启动）。同 callId 重复广告时取**先**的一条（后一条在上游会
 * 被判 `assistant/message repeats advertised tool call`，由结构校验兜底）。
 * @param region - 同一个 step 的事件区间（不含 step/start 与 step/end）。
 * @returns callId → 广告事件时间（合成修复事件的时间取它，缺省 0）。
 */
function unsettledToolCalls(region: readonly Record<string, unknown>[]): Map<string, number> {
  const advertised = new Map<string, number>();
  for (const event of region) {
    if (event.type === "assistant/message") {
      for (const block of contentBlocksOf(event)) {
        if (block.type === "tool-call" && typeof block.id === "string" && !advertised.has(block.id)) {
          advertised.set(block.id, timeOf(event) ?? 0);
        }
      }
      continue;
    }
    if (event.type === "tool/result") {
      const callId = toolResultCallId(event);
      if (callId !== undefined) advertised.delete(callId);
    }
  }
  return advertised;
}

/**
 * 合成 dsh 官方的「工具未启动」修复事件（TOOL_NOT_STARTED）。
 *
 * 逐字段对照上游 `session-format-v0-to-v1/src/relationships.ts` 的 `isExactToolNotStartedRepair`
 * （以及 v2→v3 的 `isRepairIdentity`、v3→v4 的 `notStartedRepair`）：
 * `error.name/code`、**不得有** `sourceEventSeqs`、`message.id === interrupted-tool-result-<callId>-<seq>`
 * （seq 是**最终**序号，故先占位、重编号后由 {@link fillRepairIds} 回填）、
 * `message.source = {kind:'tool', callId}`、内容恰好一个 `isError:true` 的 tool-result 包装块、
 * 该包装块内含恰好一个官方文案文本块。
 */
function buildToolNotStartedRepair(callId: string, turn: number, step: number, time: number): PendingRepairEvent {
  const event: Record<string, unknown> = {
    type: "tool/result",
    seq: -1,
    time,
    surfaceOp: "append",
    data: {
      turn,
      step,
      message: {
        id: "", // 占位：最终 seq 决定（fillRepairIds）
        role: "user",
        source: { kind: "tool", callId },
        content: [{
          type: "tool-result",
          toolCallId: callId,
          isError: true,
          content: [{ type: "text", text: TOOL_NOT_STARTED_TEXT }],
        }],
      },
      error: { name: TOOL_NOT_STARTED_ERROR_NAME, code: TOOL_NOT_STARTED_ERROR_CODE },
    },
  };
  return { event, callId };
}

/**
 * 事件层关系修复（derive 之后、重编号之前）：补上 wire 投影做不到的两件事。
 *
 * 1. **首条非 user**：投影对「首条 assistant/tool」只隐式 `turn++`（不发 turn/start 与 step/start），
 *    dsh 的 turn/step 配对校验会以 `assistant/message does not match an open turn and step` 拒收
 *    （`POST /api/sessions/import` 导入的任意 JSONL 很容易命中）→ 在第一个事件前补
 *    `turn/start{turn:1}` + `step/start{turn:1,step:1}`（与投影的隐式编号一致）；
 * 2. **未结算的 tool_call**（已广告但没有任何 tool/result 结算）：回合被中断的会话就是这样
 *    （dsh 拒收：`step/end leaves unresolved tool call <id>`）→ 在该 step 的 `step/end` **之前**插入
 *    官方认的「工具未启动」修复事件（{@link buildToolNotStartedRepair}）。
 *
 * 畸形流的拒绝策略：有未结算调用但找不到可插入的 `step/end` → 抛错拒绝导出（宁可不导出，也不写坏文件）。
 * @param events - 事件流（原地修改）。
 * @param messageStarts - 消息 → 首条事件下标（插入事件时同步平移）。
 * @param warnings - 修复说明。
 * @returns 合成的事件（`message.id` 待重编号后回填）。
 */
function repairEventRelationships(
  events: Array<Record<string, unknown>>,
  messageStarts: number[],
  warnings: string[],
): PendingRepairEvent[] {
  const repairs: PendingRepairEvent[] = [];
  const first = events[0];
  if (first !== undefined && first.type !== "turn/start") {
    const time = timeOf(first) ?? 0;
    spliceEvents(events, 0, [
      { type: "turn/start", seq: -1, time, data: { turn: 1 } },
      { type: "step/start", seq: -1, time, data: { turn: 1, step: 1 } },
    ], messageStarts);
    warnings.push("会话历史的首条消息不是用户消息（历史被截断或来自外部导入）：已补 turn/start{turn:1} 与 step/start{turn:1,step:1}，使首条 assistant/tool 事件落在已开启的 step 内");
  }
  // 逐 step 处理：插入点必须在「该 step 的 step/end」之前（修复事件本身要求落在 open step 内）。
  let index = 0;
  while (index < events.length) {
    const event = events[index]!;
    if (event.type !== "step/start") {
      index += 1;
      continue;
    }
    const end = findStepEnd(events, index + 1);
    const unsettled = unsettledToolCalls(events.slice(index + 1, end < 0 ? events.length : end));
    if (unsettled.size === 0) {
      index = end < 0 ? events.length : end + 1;
      continue;
    }
    const data = asRecord(event.data);
    const turn = positiveOr(data?.turn, 1);
    const step = positiveOr(data?.step, 1);
    if (end < 0) {
      throw new Error(`导出拒绝：turn ${turn} step ${step} 有未结算的工具调用 ${[...unsettled.keys()][0]}，但事件流里没有对应的 step/end 可插入修复事件（会话历史畸形）`);
    }
    const inserted = [...unsettled].map(([callId, time]) => buildToolNotStartedRepair(callId, turn, step, time));
    spliceEvents(events, end, inserted.map((repair) => repair.event), messageStarts);
    repairs.push(...inserted);
    for (const callId of unsettled.keys()) {
      warnings.push(`工具调用 ${callId} 只有广告没有结果（回合被中断），已按 dsh 官方的「工具未启动」形态在该 step 的 step/end 前补一条修复 tool/result`);
    }
    index = end + inserted.length + 1;
  }
  return repairs;
}

/** 稠密重编 seq 之后回填合成修复事件的 `message.id`（官方要求 id 后缀 = 该事件的最终 seq）。 */
function fillRepairIds(repairs: readonly PendingRepairEvent[]): void {
  for (const repair of repairs) {
    const message = asRecord(asRecord(repair.event.data)?.message);
    if (message === undefined) continue;
    message.id = `${TOOL_NOT_STARTED_MESSAGE_PREFIX}${repair.callId}-${seqOf(repair.event)}`;
  }
}

/**
 * 重排后的**后置不变量**：每个 `tool/call` 之前必须出现过同 callId 且 name/arguments 完全一致的
 * `assistant/message` 广告（dsh 关系校验的 `tool/call ... does not match one advertised tool call`）。
 *
 * {@link reorderAssistantToolCalls} 是「尽力而为」的搬运（形状对不上就不动），这里把「没搬成功」
 * 从「静默产出坏文件」变成显式失败。
 * @throws {Error} 任一个 `tool/call` 找不到匹配广告时（导出拒绝）。
 */
function assertToolCallsAdvertised(events: readonly Record<string, unknown>[]): void {
  const advertised = new Map<string, { name: unknown; arguments: unknown }>();
  for (const event of events) {
    if (event.type === "assistant/message") {
      for (const block of contentBlocksOf(event)) {
        if (block.type !== "tool-call" || typeof block.id !== "string") continue;
        advertised.set(block.id, { name: block.name, arguments: block.arguments });
      }
      continue;
    }
    if (event.type !== "tool/call") continue;
    const data = asRecord(event.data);
    const callId = data?.callId;
    const lifecycle = typeof callId === "string" ? advertised.get(callId) : undefined;
    if (lifecycle === undefined || lifecycle.name !== data?.name || lifecycle.arguments !== data?.arguments) {
      throw new Error(`导出拒绝：tool/call ${String(callId)} 之前没有匹配的 assistant/message 广告（dsh 要求同 callId 且 name/arguments 完全一致）`);
    }
  }
}

/**
 * 维护 surface 数组（append 语义）并返回新值；违规只记录不抛错（由调用方汇总）。
 * dsh 的规则（上游 `applySurface`）：surface 事件必带 `surfaceOp`；`replace` 的 `[startSeq,endSeq]`
 * 两端点必须都还在**此前**的 surface 上（起点在终点之前），且被遮蔽的 surface seq 必须全部出现在
 * `sourceEventSeqs` 里。
 */
function applySurfaceMark(
  surface: readonly number[],
  event: Record<string, unknown>,
  index: number,
  fail: (message: string) => void,
): number[] {
  const type = String(event.type);
  const operation = event.surfaceOp;
  if (operation === undefined) {
    fail(`${type}（seq ${index}）缺少 surfaceOp 标记`);
    return [...surface];
  }
  if (operation === "append") return [...surface, index];
  const replace = asRecord(operation);
  const startSeq = replace?.startSeq;
  const endSeq = replace?.endSeq;
  if (replace?.op !== "replace" || typeof startSeq !== "number" || typeof endSeq !== "number") {
    fail(`${type}（seq ${index}）的 surfaceOp 形态非法（只接受 "append" 或 {op:'replace',startSeq,endSeq}）`);
    return [...surface];
  }
  const start = surface.indexOf(startSeq);
  const end = surface.indexOf(endSeq);
  if (start < 0 || end < start) {
    fail(`${type}（seq ${index}）的 replace 区间 [${startSeq},${endSeq}] 不在当前 surface 上`);
    return [...surface];
  }
  const shadowed = surface.slice(start, end + 1);
  const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
  const missing = shadowed.filter((seq) => !sources.includes(seq));
  if (missing.length > 0) {
    fail(`${type}（seq ${index}）的 sourceEventSeqs 没有覆盖被遮蔽的 surface seq ${missing.join("、")}`);
    return [...surface];
  }
  return [...surface.slice(0, start), index, ...surface.slice(end + 1)];
}

/**
 * 是否为 dsh 官方「工具未启动」修复形态（逐字段对照上游 `isExactToolNotStartedRepair`）：
 * `error.name/code` 精确、不得有 `sourceEventSeqs`、`message.id` 是
 * `interrupted-tool-result-<callId>-<数字>`、唯一内容块 `isError:true`、内含恰好一个官方文案文本块。
 */
function isToolNotStartedRepair(event: Record<string, unknown>): boolean {
  const data = asRecord(event.data);
  const message = asRecord(data?.message);
  const error = asRecord(data?.error);
  const callId = toolResultCallId(event);
  if (message === undefined || callId === undefined) return false;
  if (error?.name !== TOOL_NOT_STARTED_ERROR_NAME || error.code !== TOOL_NOT_STARTED_ERROR_CODE) return false;
  if (event.sourceEventSeqs !== undefined) return false;
  const prefix = `${TOOL_NOT_STARTED_MESSAGE_PREFIX}${callId}-`;
  const id = message.id;
  if (typeof id !== "string" || !id.startsWith(prefix)) return false;
  const suffix = id.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) return false;
  const wrapper = contentBlocksOf(event)[0];
  if (wrapper === undefined || wrapper.type !== "tool-result" || wrapper.isError !== true) return false;
  const inner = Array.isArray(wrapper.content) ? wrapper.content : [];
  const text = asRecord(inner[0]);
  return inner.length === 1 && text?.type === "text" && text.text === TOOL_NOT_STARTED_TEXT;
}

/**
 * tool/result 的 message 必须是「恰好一个与 source.callId 一致的 tool-result 包装块」
 * （上游 `liftToolResult`：`requires exactly one tool-result wrapper matching its tool source`）。
 * @returns 违规描述；合法时 undefined。
 */
function toolResultWrapperViolation(event: Record<string, unknown>, index: number, callId: string): string | undefined {
  const message = asRecord(asRecord(event.data)?.message);
  const blocks = contentBlocksOf(event);
  const wrapper = blocks.length === 1 ? blocks[0] : undefined;
  if (message?.role !== "user") return `tool/result（seq ${index}）的 message.role 不是 user（v3 的工具结果消息是 user 角色 + tool-result 包装块）`;
  if (wrapper === undefined || wrapper.type !== "tool-result" || wrapper.toolCallId !== callId) {
    return `tool/result（seq ${index}）的 message.content 必须恰好一个 tool-result 包装块、且 toolCallId 与 source.callId（${callId}）一致`;
  }
  return undefined;
}

/**
 * 写盘前的**结构校验**（纯函数，不依赖 dsh 上游 lib）：返回全部违规描述（空数组 = 通过）。
 *
 * 覆盖规则（{@link writeDshSession} 据此拒绝写出坏文件）：
 * 1. `seq` 稠密（下标即 seq）、`time` 为非负安全整数；
 * 2. turn/step 配对：`turn/start` 从 1 起递增且不与上一轮重叠、`step/start` 必须落在 open turn 内且
 *    步号递增、`step/end` / `turn/end` 与 open turn+step 配对；
 * 3. 四类 surface 事件必带 `surfaceOp`；`replace` 的两端点必须都在**此前 surface** 上（append 语义维护
 *    surface 数组），且被遮蔽的 surface seq 全部出现在 `sourceEventSeqs` 里；
 * 4. `assistant/message` 落在 open step 内，其 tool-call 块逐个登记「广告」（重复广告 = 违规）；
 * 5. `tool/call` 匹配已广告的 callId 且 name/arguments 完全一致，匹配后标记为已启动；
 * 6. `tool/result`（append）的 callId 必须已启动；「已广告未启动」只接受精确的 TOOL_NOT_STARTED 修复形态，
 *    结算后销毁该生命周期；工具结果消息还必须恰好一个包装块且与 source.callId 一致；
 * 7. 每个已广告的 call 都必须在 `step/end` 之前被 tool/result 结算（dsh 的未结算工具调用拒收）。
 * @param events - 待写盘的事件流（不修改）。
 * @returns 违规描述列表（首条即写盘报错里贴出的那条）。
 */
export function validateDshEvents(events: readonly Record<string, unknown>[]): string[] {
  const violations: string[] = [];
  const fail = (message: string): void => {
    violations.push(message);
  };
  let surface: number[] = [];
  let openTurn: number | null = null;
  let openStep: number | null = null;
  let nextTurn = 1;
  let nextStep = 1;
  /** 已广告的工具生命周期（callId → 广告的 name/arguments + 是否已启动）。 */
  const lifecycles = new Map<string, { name: unknown; arguments: unknown; started: boolean }>();
  const inOpenStep = (event: Record<string, unknown>, index: number): boolean => {
    const data = asRecord(event.data);
    if (openTurn === null || openStep === null || data?.turn !== openTurn || data?.step !== openStep) {
      fail(`${String(event.type)}（seq ${index}）不在 open step 内（turn=${String(data?.turn)} step=${String(data?.step)}，当前 open turn=${String(openTurn)} step=${String(openStep)}）`);
      return false;
    }
    return true;
  };
  events.forEach((event, index) => {
    const type = String(event.type);
    const data = asRecord(event.data);
    if (event.seq !== index) fail(`${type} 的 seq=${String(event.seq)} 与下标 ${index} 不一致（事件坐标必须稠密）`);
    if (typeof event.time !== "number" || !Number.isSafeInteger(event.time) || event.time < 0) {
      fail(`${type}（seq ${index}）的 time 不是非负安全整数：${String(event.time)}`);
    }
    if (SURFACE_TYPES.includes(type)) surface = applySurfaceMark(surface, event, index, fail);
    switch (type) {
      case "turn/start": {
        const turn = data?.turn;
        if (openTurn !== null) fail(`turn/start（seq ${index}）在上一轮 turn ${openTurn} 未结束时出现`);
        else if (turn !== nextTurn) fail(`turn/start（seq ${index}）的 turn=${String(turn)} 不是期望的 ${nextTurn}`);
        else {
          openTurn = nextTurn;
          openStep = null;
          nextStep = 1;
          lifecycles.clear();
        }
        return;
      }
      case "turn/end": {
        if (data?.turn !== openTurn) fail(`turn/end（seq ${index}）的 turn=${String(data?.turn)} 没有对应的 open turn`);
        else if (openStep !== null) fail(`turn/end（seq ${index}）跨过了未结束的 step ${openStep}`);
        else {
          openTurn = null;
          nextTurn += 1;
        }
        return;
      }
      case "step/start": {
        if (openTurn === null || openStep !== null || data?.turn !== openTurn || data?.step !== nextStep) {
          fail(`step/start（seq ${index}）不在 open turn 内的期望步号上（turn=${String(data?.turn)} step=${String(data?.step)}；当前 open turn=${String(openTurn)} 下一 step=${nextStep}）`);
        } else {
          openStep = nextStep;
        }
        return;
      }
      case "step/end": {
        if (openTurn === null || openStep === null || data?.turn !== openTurn || data?.step !== openStep) {
          fail(`step/end（seq ${index}）与 open turn/step 不配对（turn=${String(data?.turn)} step=${String(data?.step)}）`);
          return;
        }
        const unresolved = lifecycles.keys().next().value;
        if (unresolved !== undefined) fail(`step/end（seq ${index}，turn ${openTurn} step ${openStep}）之前工具调用 ${unresolved} 仍未结算`);
        lifecycles.clear();
        openStep = null;
        nextStep += 1;
        return;
      }
      case "assistant/message": {
        inOpenStep(event, index);
        for (const block of contentBlocksOf(event)) {
          if (block.type !== "tool-call") continue;
          const callId = block.id;
          if (typeof callId !== "string" || callId.length === 0) {
            fail(`assistant/message（seq ${index}）的 tool-call 块缺少非空 id`);
            continue;
          }
          if (lifecycles.has(callId)) {
            fail(`assistant/message（seq ${index}）重复广告工具调用 ${callId}`);
            continue;
          }
          lifecycles.set(callId, { name: block.name, arguments: block.arguments, started: false });
        }
        return;
      }
      case "tool/call": {
        inOpenStep(event, index);
        const callId = data?.callId;
        const lifecycle = typeof callId === "string" ? lifecycles.get(callId) : undefined;
        if (lifecycle === undefined || lifecycle.started || lifecycle.name !== data?.name || lifecycle.arguments !== data?.arguments) {
          fail(`tool/call（seq ${index}）的 callId=${String(callId)} 没有匹配的已广告工具调用（name/arguments 必须完全一致）`);
          return;
        }
        lifecycle.started = true;
        return;
      }
      case "tool/result": {
        if (event.surfaceOp !== "append") {
          if (openTurn === null) fail(`tool/result（seq ${index}）的 replace 形态落在 open turn 之外`);
          return;
        }
        if (!inOpenStep(event, index)) return;
        const callId = toolResultCallId(event);
        if (callId === undefined) {
          fail(`tool/result（seq ${index}）的 message.source.callId 不是非空字符串`);
          return;
        }
        const wrapperViolation = toolResultWrapperViolation(event, index, callId);
        if (wrapperViolation !== undefined) fail(wrapperViolation);
        const lifecycle = lifecycles.get(callId);
        if (lifecycle === undefined) {
          fail(`tool/result（seq ${index}）的 callId=${callId} 没有已广告的工具生命周期`);
          return;
        }
        if (!lifecycle.started && !isToolNotStartedRepair(event)) {
          fail(`tool/result（seq ${index}）的 callId=${callId} 尚未启动，且不是精确的 TOOL_NOT_STARTED 修复形态`);
          return;
        }
        lifecycles.delete(callId);
        return;
      }
      default:
        return;
    }
  });
  return violations;
}

/**
 * 找压缩锚点（最后一条被压缩消息）的下标。
 * 优先按 `uptoMessageId` 定位；缺省回退 `uptoIndex - 1`（`messages[0..uptoIndex)` 语义）。
 * 被拆分的多结果 tool 消息 id 变成 `<原id>-<i>`：锚点指向原 id 时取最后一个碎片（拆分保序，末片即该消息尾部）。
 * @returns 消息下标；找不到时 undefined（并记 warning）。
 */
function compactionAnchor(messages: readonly ChatMessage[], compacted: DshExportLedgerCompacted, warnings: string[]): number | undefined {
  if (compacted.uptoMessageId !== undefined && compacted.uptoMessageId.length > 0) {
    const exact = messages.findIndex((message) => message.id === compacted.uptoMessageId);
    if (exact >= 0) return exact;
    const splitPrefix = `${compacted.uptoMessageId}-`;
    let lastSplit = -1;
    messages.forEach((message, index) => {
      if (message.id.startsWith(splitPrefix)) lastSplit = index;
    });
    if (lastSplit >= 0) return lastSplit;
    warnings.push(`压缩锚点消息 ${compacted.uptoMessageId} 不在导出消息列表里，放弃压缩导出`);
    return undefined;
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
  messages: readonly ChatMessage[],
  events: Array<Record<string, unknown>>,
  messageStarts: readonly number[],
  sessionId: string,
  warnings: string[],
): void {
  const compacted = input.ledger?.compacted;
  if (compacted === undefined) return;
  const anchor = compactionAnchor(messages, compacted, warnings);
  if (anchor === undefined) return;
  const start = messageStarts[anchor];
  if (start === undefined) {
    warnings.push(`压缩锚点消息 ${messages[anchor]?.id ?? anchor} 没有派生事件，放弃压缩导出`);
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
 * 处理顺序（有依赖关系，不要重排）：
 * 1. **消息层预处理**（{@link preprocessExportMessages}）：孤儿 tool_result 丢弃、多结果 tool 消息拆分；
 * 2. 派生事件 = {@link deriveSessionRecords}(messages) 的 records 剥壳（time 取消息 createdAt 毫秒）；
 * 3. **工具生命周期重排**（{@link reorderAssistantToolCalls}，此时 messageStarts 还是派生的原下标）；
 * 4. **事件关系修复**（{@link repairEventRelationships}）：补首条非 user 的 turn/step 头 + 未结算工具调用的
 *    官方修复事件（插入会平移 messageStarts，因此必须在重排之后）；
 * 5. 稠密重编 seq + 回填修复事件的 message.id + 重排后置不变量（{@link assertToolCallsAdvertised}）；
 * 6. 图片 → 内容寻址附件引用（顶层 `image` 块 + tool-result 包装块内的 `media[]`）、
 *    assistant 消息的 `source.replayState`（{@link applyReplayState}）、`session/title`、压缩导出
 *    （后三者的 seq 引用都按最终编号计算）。
 *
 * 输出必须通过 {@link validateDshEvents}（{@link writeDshSession} 在写盘前把关）。
 * @param input - 导出输入（`cwd` 必须绝对路径；`messages` 必须已是**活动路径**）。
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
  // 1) 消息层预处理（dsh 的事件形态表达不了的形状：孤儿结果、一条消息多个结果）
  const messages = preprocessExportMessages(input.messages, warnings);
  const { records, messageStarts } = deriveSessionRecords(messages, { provider, model });
  const events: Array<Record<string, unknown>> = records.map((record) => record.event as Record<string, unknown>);
  // 2) 工具生命周期重排（requires 派生时算出的 messageStarts，必须在插入事件之前跑）
  reorderAssistantToolCalls(events, messages, messageStarts);
  // 3) 事件关系修复（首条非 user 补 start；未结算工具调用补官方修复事件）+ 稠密重编 seq
  const repairs = repairEventRelationships(events, messageStarts, warnings);
  renumberSeq(events);
  fillRepairIds(repairs);
  assertToolCallsAdvertised(events);
  const createdAt = Date.parse(input.meta.createdAt ?? "") || Date.now();
  if (provider.length === 0 || model.length === 0) {
    // 只在确实有 assistant 消息时提醒：dsh 加载校验要求模型归属非空，空串会被拒。
    if (messages.some((message) => message.role === "assistant")) {
      warnings.push("未提供 meta.provider/model：assistant 事件的 source.provider/model 为空串，dsh 侧加载时可能拒绝该会话");
    }
  }
  const header: Record<string, unknown> = {
    type: "session",
    version: DSH_SYNC_WRITE_GENERATION,
    id: sessionId,
    createdAt,
    isSeeded: false,
    // M5a：子代理会话的头行（dsh 侧 origin/parentSession/delegationDepth 三件套必须同时给出）；
    // 嵌套子代理逐层递增（缺省 1 = 直接子会话），dsh 据此还原委托层级。
    delegationDepth: input.subagent === undefined ? 0 : (input.subagent.delegationDepth ?? 1),
    cwd: input.cwd,
    ...(input.subagent === undefined ? {} : {
      origin: "subagent",
      parentSession: input.subagent.parentSession,
      ...(input.subagent.agentPreset === undefined || input.subagent.agentPreset.length === 0
        ? {}
        : { agentPreset: input.subagent.agentPreset }),
    }),
  };

  // 1) 图片块 → 附件引用（同一内容多次出现时 writeDshAttachment 幂等去重）：
  //    顶层 image 块 + tool/result 包装块内的 media[]（后者既有投影不产出块，这里补）。
  const sources = imageSourceIndex(messages);
  const mediaSources = toolResultMediaIndex(messages);
  const attachmentWrites: DshExportAttachmentWrite[] = [];
  for (const event of events) rewriteEventImages(event, sources, mediaSources, attachmentWrites, warnings);

  // 2) assistant 消息的回放元数据（thinking signature/redacted → source.replayState；
  //    仅在会话 provider 的接口协议承载 replay 时写，丢弃一律告警）
  applyReplayState(events, messages, provider.length === 0 ? undefined : input.providerInterfaces?.[provider], warnings);

  // 3) 标题（dsh 头行没有 title 字段；标题是 session/title 事件，messageSeqs 必须引用更早的 user/message）
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

  // 4) 压缩导出
  appendCompaction(input, messages, events, messageStarts, sessionId, warnings);
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
    throw new Error("当前 Node 运行时缺少 zstd 压缩能力（需要 Node ≥ 24.22.1），无法写出 dsh v3 会话");
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
    generation: DSH_SYNC_WRITE_GENERATION,
    compressed: true,
  });
  if (decoded.header.id !== sessionId) {
    throw new Error(`导出自检失败：回读头行 id=${String(decoded.header.id)} 与 ${sessionId} 不一致`);
  }
  if (decoded.header.version !== DSH_SYNC_WRITE_GENERATION) {
    throw new Error(`导出自检失败：回读头行 version=${String(decoded.header.version)} 不是 v${DSH_SYNC_WRITE_GENERATION}`);
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
 * 流程：**写盘前结构校验**（{@link validateDshEvents}，违规即拒绝写出）→ 目录已存在即拒绝 →
 * mkdir -p → 附件内容寻址落盘 → 头帧 + 事件帧写 `session.v3.jsonl.zstd` → 回读自检；
 * 任一步失败都删除本次新建的目录再把错误抛给调用方（校验在任何文件系统改动之前，因此不需要清理）。
 * @param input - 导出输入（`cwd` 必须绝对路径；`messages` 必须已是会话的**活动路径**）。
 * @param sessionId - 目标会话 id；缺省新生成一个 uuid（显式传入便于测试与「同一 id 冲突检测」）。
 * @returns 落盘结果（含降级警告）。
 */
export async function writeDshSession(input: DshExportInput, sessionId: string = randomUUID()): Promise<DshExportResult> {
  const built = buildDshSessionEvents(input, sessionId);
  // 写盘前的结构校验（纯函数，不依赖 dsh 上游 lib）：宁可不导出，也绝不产出一份 dsh 会拒收的坏文件。
  // 放在任何文件系统改动之前：失败时连会话目录都不会出现（无需依赖失败清理）。
  const violations = validateDshEvents(built.events);
  if (violations.length > 0) {
    throw new Error(`导出拒绝：事件流没有通过 dsh 结构校验（共 ${violations.length} 处违规），首条为 ${violations[0]}`);
  }
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
