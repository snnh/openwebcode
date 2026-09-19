/**
 * owc 会话/事件 → dsh wire 值投影（M4 步骤 14b）。
 *
 * 形状权威来源：`docs/dsh-wire-contract.md`（从 vendor 的 `typert.remote-client.js` 机械提取）。
 * 原则：只做只读投影，不落盘、不建第二份会话存储；不可如实表达的能力返回 wire 错误而不是编造值。
 */
import type { AgentRunner } from "../../agent/agent-runner.js";
import type { ChatMessage, SessionMeta } from "../../sessions/types.js";
import type { SessionStore } from "../../sessions/session-store.js";
import { wireError, type DshWireError } from "./wire.js";
import { modelSelectionValue, type DshModelSelection } from "./models.js";
import {
  deriveSessionRecords,
  pageWindow,
  sessionLastSeq,
  snapshotWindow,
  type DshMessageAttribution,
} from "./session-events.js";

/** 投影所需的最小依赖面（便于单测注入假对象）。 */
export interface DshProjectionDeps {
  sessions: Pick<SessionStore, "list" | "create" | "getTail" | "get" | "getMeta" | "updateConfig">;
  agent: Pick<
    AgentRunner,
    "run" | "isRunning" | "abort" | "enqueueSteering" | "enqueueFollowUp" | "listQueue" | "updateQueue" | "removeQueue"
  >;
  /**
   * 非阻塞 run 的失败留痕（与 REST `/messages` 路径同语义：浏览器已拿到 accepted，
   * 详细失败留在 server 日志与 `agent.error` 事件里）。
   */
  logger?: { warn(message: string): void };
  /** 未显式指定 cwd 时使用的默认工作目录（会话创建）。 */
  defaultCwd: string;
  /**
   * 新建会话的隐式模型（settings defaultModel + 校验过的 defaultEffort）。
   * 与 REST 路径同口径：会话不带 provider/model 就无法运行，故创建时补齐。
   */
  defaultSelection?: () => DshModelSelection | undefined;
  /** 图片上限投影（dsh 附件 UI 用来预校验；缺省则不下发该 projection）。 */
  imageLimits?: {
    maxImageBytes: number;
    maxImagesPerMessage: number;
    maxMessageImageBytes: number;
    maxImagePixels: number;
    maxImageDimension: number;
    mediaTypes: string[];
  };
  /**
   * 新建会话后的可见性补发（与 REST `/api/sessions` 创建路径同一条链路：`session.created`）。
   * 缺省不发事件（单测注入假依赖时不关心可见性）。
   */
  publishSessionCreated?: (session: SessionMeta) => void;
}

/** 投影结果：合法值或缺省 wire 错误。 */
export type DshProjected<T> = { value: T } | { error: DshWireError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** ISO 时间 → 毫秒时间戳（dsh wire 用 number）。 */
function toMillis(iso: string | undefined): number {
  if (iso === undefined) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 会话是否「空白」（无用户消息）；尾部消息被截断时保守判为「非空白」。 */
function isBlank(messages: readonly ChatMessage[], truncated: boolean): boolean {
  return !truncated && !messages.some((message) => message.role === "user");
}

/** 最近一条用户消息时间（毫秒；无用户消息为 null）。 */
function lastPromptAt(messages: readonly ChatMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return toMillis(message.createdAt) || null;
  }
  return null;
}

/** dsh `SessionSummary.projections.values`（v1 投影 title 与 sessionListMetadata，另附 imageLimits）。 */
function projectionValues(deps: DshProjectionDeps, meta: SessionMeta, tail: { messages: readonly ChatMessage[]; truncated: boolean }): Record<string, unknown> {
  return {
    title: meta.title ?? null,
    sessionListMetadata: { blank: isBlank(tail.messages, tail.truncated), lastPromptAt: lastPromptAt(tail.messages) },
    // 模型选择器必读（缺该投影时 dsh 的 ModelDirectory 永不 resolve，composer 的模型座位一直空着）
    modelSelection: modelSelectionValue(meta),
    ...(deps.imageLimits === undefined ? {} : { imageLimits: deps.imageLimits }),
  };
}

/** 单条会话摘要（dsh `SessionSummary`）。 */
function sessionSummary(deps: DshProjectionDeps, meta: SessionMeta, tail: { messages: readonly ChatMessage[]; truncated: boolean }, running: boolean): Record<string, unknown> {
  return {
    sessionId: meta.id,
    updatedAt: toMillis(meta.updatedAt) || toMillis(meta.createdAt),
    running,
    blank: isBlank(tail.messages, tail.truncated),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    // asOfSeq：投影基线序号，口径 = 记录 seq（与 follow cursor / page cursor 一致）。
    // 只读尾部窗口时得到的水位偏小（见 projectionEntry 注释）：偏小只会被判为「较旧」，不会覆盖更新的值。
    // `running` 时末轮不收尾（append-only 稳定性，见 deriveSessionRecords 注释），水位随之少 2。
    projections: { asOfSeq: sessionLastSeq(tail.messages, !running), values: projectionValues(deps, meta, tail) },
  };
}

/**
 * 单会话投影条目（`session/control` 基线的 projections 值）：与摘要同口径。
 *
 * 长会话只读尾部 `maxMessages` 条消息时，派生出的记录 seq 是该窗口内的编号（比全量会话小）；
 * 客户端按 `asOfSeq` 比较投影新旧（小 = 旧 = 不覆盖已有值），因此偏小的水位只会让这条更「保守」。
 */
function projectionEntry(deps: DshProjectionDeps, meta: SessionMeta, tail: { messages: readonly ChatMessage[]; truncated: boolean }): Record<string, unknown> {
  return {
    // isRunning 允许缺省（部分测试替身只实现投影所需子集）：缺省按「已结束」收尾
    asOfSeq: sessionLastSeq(tail.messages, !(deps.agent.isRunning?.(meta.id) ?? false)),
    values: projectionValues(deps, meta, tail),
  };
}

/** 读尾部消息并标注是否被截断（列表页每会话 50 条，附件回读除外）。 */
async function tailOf(deps: DshProjectionDeps, sessionId: string, limit: number): Promise<{ messages: ChatMessage[]; truncated: boolean } | undefined> {
  const detail = await deps.sessions.getTail(sessionId, limit);
  if (detail === undefined) return undefined;
  return { messages: detail.messages, truncated: detail.hasMoreMessages === true };
}

/** `session/list`：读会话列表（含尾部消息以派生 blank/title 投影）。 */
export async function projectSessionList(deps: DshProjectionDeps): Promise<DshProjected<{ items: unknown[] }>> {
  const metas = await deps.sessions.list();
  const items: unknown[] = [];
  for (const meta of metas) {
    const tail = await tailOf(deps, meta.id, 50);
    if (tail === undefined) continue;
    items.push(sessionSummary(deps, meta, tail, deps.agent.isRunning(meta.id)));
  }
  return { value: { items } };
}

/** `session/create`：请求携带 sessionId 且已存在时幂等返回；否则新建。 */
export async function projectSessionCreate(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<{ sessionId: string }>> {
  const request = isRecord(args.request) ? args.request : {};
  const requested = asString(request.sessionId);
  if (requested !== undefined) {
    const existing = await deps.sessions.getMeta(requested);
    if (existing !== undefined) return { value: { sessionId: existing.id } };
  }
  const cwd = asString(request.cwd) ?? deps.defaultCwd;
  const selection = deps.defaultSelection?.();
  const created = await deps.sessions.create({
    cwd,
    ...(requested === undefined ? {} : { id: requested }),
    ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
  });
  // effort 不在 create 入参里：默认力度按 updateConfig 补一次（与 REST applySessionDefaults 同语义）
  if (selection?.reasoningEffort !== undefined) {
    await deps.sessions.updateConfig(created.id, {
      provider: selection.provider,
      model: selection.model,
      effort: selection.reasoningEffort as NonNullable<SessionMeta["effort"]>,
    });
  }
  // 绕过 REST 路由直接建会话：补发 REST 路径同款 `session.created`，
  // 否则 `$events` 的订阅端（dsh 侧边栏 / 主工作台）收不到 api-session/added，会话列表不刷新
  deps.publishSessionCreated?.(created);
  return { value: { sessionId: created.id } };
}

/** 把 dsh 的 prompt content 块映射成 owc 的文本与图片入参。 */
export function mapPromptContent(content: unknown): { text: string; images: Array<{ mediaType: string; data: string }> } | { error: DshWireError } {
  if (!Array.isArray(content)) return { error: wireError("session/arguments-invalid", "request.content 必须是数组") };
  const texts: string[] = [];
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const part of content) {
    if (!isRecord(part)) return { error: wireError("session/arguments-invalid", "content 块必须是对象") };
    if (part.type === "text") {
      if (typeof part.text !== "string") return { error: wireError("session/arguments-invalid", "text 块缺少 text") };
      texts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      if (typeof part.data !== "string" || typeof part.mediaType !== "string") {
        return { error: wireError("session/arguments-invalid", "image 块缺少 data/mediaType") };
      }
      images.push({ mediaType: part.mediaType, data: part.data });
      continue;
    }
    if (part.type === "file") {
      // 文件附件走 dsh 自己的 fileUploads 面（owc v1 不实现 receipt 体系）：如实报未实现
      return { error: wireError("session/unsupported", "v1 不支持 file 附件（请改用图片或把路径写进消息文本）", { part: "file" }) };
    }
    return { error: wireError("session/arguments-invalid", `未知 content 块：${String(part.type)}`) };
  }
  return { text: texts.join("\n\n"), images };
}

/** `session/prompt`：空闲起一轮，运行中按 mode 入队（queue）或插话（steer）。 */
export async function projectSessionPrompt(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<{ accepted: true }>> {
  const request = isRecord(args.request) ? args.request : {};
  const sessionId = asString(request.sessionId);
  if (sessionId === undefined) return { error: wireError("session/arguments-invalid", "request.sessionId 缺失") };
  const meta = await deps.sessions.getMeta(sessionId);
  if (meta === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  const mapped = mapPromptContent(request.content);
  if ("error" in mapped) return { error: mapped.error };
  if (mapped.text.trim() === "" && mapped.images.length === 0) {
    return { error: wireError("session/arguments-invalid", "消息内容为空") };
  }
  const mode = request.mode === "steer" ? "steer" : "queue";
  if (deps.agent.isRunning(sessionId)) {
    // 运行中入队/插话的入参只有文本（agent 侧 enqueue* 只收 string）：图片无法如实送达，
    // 因此明确失败而不是静默丢图（见 help/dsh-compat.md「已知限制」）
    if (mapped.images.length > 0) {
      return {
        error: wireError(
          "session/unsupported",
          `运行中消息不支持图片附件（${mode === "steer" ? "插话" : "排队"}）：请等本轮结束后发送，或改用文本`,
          { images: mapped.images.length, mode },
        ),
      };
    }
    if (mode === "steer") await deps.agent.enqueueSteering(sessionId, mapped.text);
    else await deps.agent.enqueueFollowUp(sessionId, mapped.text);
  } else {
    // **不等待整轮**：与 REST `/api/sessions/:id/messages` 的 202 语义一致（那里也是
    // `void agent.run(...).catch(...)`）。此前的实现 await 到整轮结束，导致
    // ① dsh UI 的发送请求被整轮阻塞（长回合/等待审批时会一直挂着）；
    // ② provider 错误被当作 RPC 错误抛出，而不是走 `agent.error` 事件（UI 有专门的错误位）。
    // 会话存在性与「是否在跑」已在上方校验，其余失败由 AgentRunner 自行发 `agent.error`。
    void deps.agent.run(sessionId, mapped.text, mapped.images.length === 0 ? {} : { images: mapped.images })
      .catch((error: unknown) => {
        deps.logger?.warn(`dsh session/prompt 后台 run 失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }
  return { value: { accepted: true } };
}

/** `session/cancel`：中断当前回合。 */
export async function projectSessionCancel(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<{ accepted: true }>> {
  const request = isRecord(args.request) ? args.request : {};
  const sessionId = asString(request.sessionId);
  if (sessionId === undefined) return { error: wireError("session/arguments-invalid", "request.sessionId 缺失") };
  const meta = await deps.sessions.getMeta(sessionId);
  if (meta === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  deps.agent.abort(sessionId);
  return { value: { accepted: true } };
}

/** `session/updateQueue`：edit / remove / steer（steer = 移出队列 + 立即插话）。 */
export async function projectSessionUpdateQueue(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<{ accepted: true }>> {
  const request = isRecord(args.request) ? args.request : {};
  const sessionId = asString(request.sessionId);
  const itemId = asString(request.itemId);
  if (sessionId === undefined || itemId === undefined) return { error: wireError("session/arguments-invalid", "request.sessionId/itemId 缺失") };
  const action = isRecord(request.action) ? request.action : {};
  if (action.kind === "remove") {
    const removed = await deps.agent.removeQueue(sessionId, itemId);
    return removed ? { value: { accepted: true } } : { error: wireError("session/queue-item-not-found", "队列项不存在", { sessionId, itemId }) };
  }
  if (action.kind === "edit") {
    const mapped = mapPromptContent(action.content);
    if ("error" in mapped) return { error: mapped.error };
    // 队列项内容只有文本（updateQueue 入参只有 content: string）：图片无法如实送达，明确失败而不是静默丢图
    if (mapped.images.length > 0) {
      return {
        error: wireError("session/unsupported", `队列项编辑不支持图片附件（${mapped.images.length} 张）：请先移除图片或等本轮结束后重发`, { images: mapped.images.length }),
      };
    }
    const updated = await deps.agent.updateQueue(sessionId, itemId, { content: mapped.text });
    return updated === undefined
      ? { error: wireError("session/queue-item-not-found", "队列项不存在", { sessionId, itemId }) }
      : { value: { accepted: true } };
  }
  if (action.kind === "steer") {
    const queue = await deps.agent.listQueue(sessionId);
    const item = queue.find((entry) => entry.id === itemId);
    if (item === undefined) return { error: wireError("session/queue-item-not-found", "队列项不存在", { sessionId, itemId }) };
    await deps.agent.removeQueue(sessionId, itemId);
    await deps.agent.enqueueSteering(sessionId, item.content);
    return { value: { accepted: true } };
  }
  return { error: wireError("session/arguments-invalid", `未知 action：${String(action.kind)}`) };
}

/**
 * `session/control` 首帧：Host 级基线（jobs + 按会话的投影基线）。
 *
 * 该描述符**没有业务参数**（vendor `session/control` 的 `parameters: []`，客户端调用
 * `remote.session.control(signal)`，open 帧 payload 恒为 `{args:{}}`），因此基线是 Host 级：
 * `jobs` 按会话建表（v1 不投影后台任务，如实留空），`projections` 覆盖全部会话。
 * 增量（`jobs` / `projection` 帧）v1 不发：dsh UI 的会话投影以 follow 快照为准，见 docs。
 */
export async function projectSessionControlBaseline(deps: DshProjectionDeps): Promise<DshProjected<Record<string, unknown>>> {
  const metas = await deps.sessions.list();
  const projections: Record<string, unknown> = {};
  for (const meta of metas) {
    const tail = await tailOf(deps, meta.id, 50);
    if (tail === undefined) continue;
    projections[meta.id] = projectionEntry(deps, meta, tail);
  }
  return { value: { type: "baseline", value: { jobs: {}, projections } } };
}

/** `workspace/follow` 基线：owc 无 workspace 注册表，按会话 cwd 派生工作区分组。 */
export async function projectWorkspaceBaseline(deps: DshProjectionDeps): Promise<Record<string, unknown>> {
  const metas = await deps.sessions.list();
  const byCwd = new Map<string, { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }>();
  for (const meta of metas) {
    const cwd = meta.cwd ?? deps.defaultCwd;
    const existing = byCwd.get(cwd);
    if (existing === undefined) {
      byCwd.set(cwd, {
        // workspaceId 必须稳定且可作 Record 键：cwd 的十六进制编码（dsh 侧只做分组展示）
        workspaceId: Buffer.from(cwd, "utf8").toString("hex").slice(0, 32),
        path: cwd,
        title: cwd.split(/[\\/]/).filter((segment) => segment !== "").pop() ?? cwd,
        sessionIds: [meta.id],
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
      continue;
    }
    existing.sessionIds.push(meta.id);
    if (meta.updatedAt > existing.updatedAt) existing.updatedAt = meta.updatedAt;
    if (meta.createdAt < existing.createdAt) existing.createdAt = meta.createdAt;
  }
  return { type: "baseline", value: { items: [...byCwd.values()], archivedSessionIds: [] } };
}

/**
 * 从图片字节里读真实尺寸（PNG/GIF/JPEG/WebP）；读不出返回 undefined（不编造）。
 */
export function imageDimensions(mediaType: string, bytes: Buffer): { width: number; height: number } | undefined {
  if (mediaType === "image/png" && bytes.length >= 24 && bytes.toString("latin1", 1, 4) === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mediaType === "image/gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mediaType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0..SOF15（排除 DHT 0xc4 / JPG 0xc8 / DAC 0xcc）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return undefined;
  }
  if (mediaType === "image/webp" && bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF") {
    const format = bytes.toString("latin1", 12, 16);
    if (format === "VP8X") {
      const width = 1 + (bytes.readUIntLE(24, 3) & 0xffffff);
      const height = 1 + (bytes.readUIntLE(27, 3) & 0xffffff);
      return { width, height };
    }
    if (format === "VP8 ") {
      // 关键帧头：3 字节起始码 + 2 字节宽高（低 14 位）
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (format === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return undefined;
}

/**
 * `session/attachment`：历史图片回读。owc 图片以 base64 内联在消息 content 里，
 * attachmentId 形如 `<messageId>#<index>`（由本层投影 session/follow 时生成，两边一致）。
 */
export async function projectSessionAttachment(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<Record<string, unknown>>> {
  const request = isRecord(args.request) ? args.request : {};
  const sessionId = asString(request.sessionId);
  const attachmentId = asString(request.attachmentId);
  if (sessionId === undefined || attachmentId === undefined) return { error: wireError("session/arguments-invalid", "request.sessionId/attachmentId 缺失") };
  const detail = await deps.sessions.getTail(sessionId, 200);
  if (detail === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  for (const message of detail.messages) {
    for (const [index, block] of message.content.entries()) {
      if (block.type !== "image") continue;
      if (`${message.id}#${index}` !== attachmentId) continue;
      const data = block.data;
      if (data === undefined) {
        return { error: wireError("session/attachment-unsupported", "图片仅以落盘引用存在（ref），v1 不回读", { sessionId, attachmentId }) };
      }
      const bytes = Buffer.from(data, "base64");
      const dimensions = imageDimensions(block.mediaType, bytes);
      if (dimensions === undefined) {
        return { error: wireError("session/attachment-unsupported", `无法读取图片尺寸（mediaType=${block.mediaType}）`, { sessionId, attachmentId }) };
      }
      return {
        value: {
          attachment: { attachmentId, mediaType: block.mediaType, bytes: bytes.byteLength, width: dimensions.width, height: dimensions.height },
          data,
        },
      };
    }
  }
  return { error: wireError("session/attachment-not-found", "附件不存在", { sessionId, attachmentId }) };
}

/**
 * `session/follow` 快照帧：header + cursor + records(事件序列) + hasMore + projections + assistantStream。
 *
 * `assistantStream` 基线**必须**下发（客户端在首帧缺该字段时直接抛 `gateway/internal`：
 * 「session assistant stream omitted its opted-in opening baseline」）。v1 不发 token 级增量，
 * 因此 revision 恒为 0、不带 activeAttempt（不宣称有正在进行的 attempt，避免客户端等永不到来的 chunk）。
 */
export async function projectSessionFollowSnapshot(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<Record<string, unknown>>> {
  const request = isRecord(args.request) ? args.request : {};
  const address = isRecord(request.address) ? request.address : {};
  if (address.kind !== "session") {
    // 子代理地址（kind=subagent）v1 不支持：dsh 把子代理当独立会话展示，owc 侧需要另行映射
    return { error: wireError("session/unsupported", "v1 仅支持 kind=session 的 follow 地址", { kind: String(address.kind) }) };
  }
  const sessionId = asString(address.sessionId);
  if (sessionId === undefined) return { error: wireError("session/arguments-invalid", "address.sessionId 缺失") };
  const meta = await deps.sessions.getMeta(sessionId);
  if (meta === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  const detail = await deps.sessions.get(sessionId);
  if (detail === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  const maxMessages = typeof request.maxMessages === "number" ? request.maxMessages : undefined;
  const attribution = attributionOf(meta);
  const running = deps.agent.isRunning?.(sessionId) ?? false;
  const window = snapshotWindow(detail.messages, maxMessages, attribution, !running);
  const tail = { messages: detail.messages, truncated: window.hasMore };
  return {
    value: {
      type: "snapshot",
      header: {
        version: 1,
        id: meta.id,
        createdAt: toMillis(meta.createdAt),
        ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
        isSeeded: false,
      },
      cursor: window.cursor,
      records: window.records,
      hasMore: window.hasMore,
      projections: { asOfSeq: window.cursor, values: projectionValues(deps, meta, tail) },
      assistantStream: { revision: 0 },
    },
  };
}

/** `session/page`：向前翻旧历史（对齐消息边界）。 */
export async function projectSessionPage(deps: DshProjectionDeps, args: Record<string, unknown>): Promise<DshProjected<Record<string, unknown>>> {
  const request = isRecord(args.request) ? args.request : {};
  const address = isRecord(request.address) ? request.address : {};
  if (address.kind !== "session") {
    return { error: wireError("session/unsupported", "v1 仅支持 kind=session 的分页地址", { kind: String(address.kind) }) };
  }
  const sessionId = asString(address.sessionId);
  if (sessionId === undefined) return { error: wireError("session/arguments-invalid", "address.sessionId 缺失") };
  const throughSeq = typeof request.throughSeq === "number" ? request.throughSeq : 0;
  const beforeSeq = typeof request.beforeSeq === "number" ? request.beforeSeq : undefined;
  const maxMessages = typeof request.maxMessages === "number" ? request.maxMessages : undefined;
  const detail = await deps.sessions.get(sessionId);
  if (detail === undefined) return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  const meta = await deps.sessions.getMeta(sessionId);
  const window = pageWindow(detail.messages, throughSeq, beforeSeq, maxMessages, attributionOf(meta), !(deps.agent.isRunning?.(sessionId) ?? false));
  return { value: { records: window.records, hasMore: window.hasMore } };
}

/**
 * 会话级模型归属（`assistant/message.message.source` 的 provider/model）：
 * vendor UI 的 `messageRoute()` 直接读这两个字段（缺失即渲染抛错），owc 不逐条记录归属，用会话值。
 */
function attributionOf(meta: SessionMeta | undefined): DshMessageAttribution {
  return { provider: meta?.provider ?? "", model: meta?.model ?? "" };
}

/** 会话当前完整事件记录（供 follow 增量去重：seq ≤ cursor 的都已下发过）。 */
export async function sessionRecordsSince(deps: DshProjectionDeps, sessionId: string, cursor: number): Promise<Array<Record<string, unknown>>> {
  const detail = await deps.sessions.get(sessionId);
  if (detail === undefined) return [];
  const meta = await deps.sessions.getMeta(sessionId);
  return deriveSessionRecords(detail.messages, attributionOf(meta), !(deps.agent.isRunning?.(sessionId) ?? false)).records
    .filter((record) => record.event.seq > cursor) as unknown as Array<Record<string, unknown>>;
}
