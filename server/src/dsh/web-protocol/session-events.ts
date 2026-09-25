/**
 * owc 消息历史 → dsh `SessionWireEvent` 序列投影（M4 步骤 14c）。
 *
 * 事件形状来自上游 `packages/core/session/src/types.ts` 的 `SessionEventMap`：
 *   turn/start {turn} / step/start {turn, step} / step/end {turn, step} / turn/end {turn, reason}
 *   user/message      data = UserMessage（{id, role:'user', content, source}）
 *   assistant/message data = {turn, step, message: AssistantMessage, stream: AssistantStreamRecord[], usage?, interrupted?}
 *   tool/call         data = {turn, step, callId, name, arguments}
 *   tool/result       data = {turn, step, message: ToolResultMessage}
 *
 * 说明（与计划一致的如实边界）：
 * - owc 无 turn/step 概念：按「一条 user 消息开一个新 turn、step 恒为 1」投影，turn 序号即用户消息序号；
 * - `assistant/message.stream`（精确增量打包）v1 留空数组：不编造增量，文本仍由 `message.content` 如实呈现；
 * - 实时增量（`assistant-stream` 帧）v1 不发，改为回合结束后下发完整事件（见 streams.ts）。
 */
import type { ChatMessage, MessageContent } from "../../sessions/types.js";
import { imageDimensions } from "./session-projection.js";

/** 一条 wire 记录（`session/follow` 的 records 元素 / `session/page` 的 records 元素）。 */
export interface DshWireRecord {
  type: "event";
  event: {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    /**
     * surface-eligible 事件（`system/message`、`user/message`、`assistant/message`、`tool/result`）
     * 必带该标记：vendor 客户端的 `assertSessionWireEvent`/`surfaceOpOf` 对四类事件逐条断言，
     * 缺标记直接抛错（整个会话渲染不出来）。这里全部投影为「追加」，不做 replace 语义。
     */
    surfaceOp?: "append";
  };
}

/** surface-eligible 事件的标记值（vendor `surface.js` 的 `op === "append"` 分支）。 */
const SURFACE_APPEND = "append";

/** 一个 turn 的结束原因（v1 只有 completed，如实反映 owc 已落盘的历史）。 */
const TURN_END_COMPLETED = { kind: "completed" } as const;

/** owc 内容块 → dsh ContentBlock（不可表达的块降级为文本说明，不静默丢弃）。 */
function toDshBlocks(message: ChatMessage, blocks: readonly MessageContent[]): unknown[] {
  const result: unknown[] = [];
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "text":
        result.push({ type: "text", text: block.text });
        return;
      case "thinking":
        result.push({ type: "reasoning", text: block.text });
        return;
      case "tool_call":
        result.push({ type: "tool-call", id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        return;
      case "tool_result":
        result.push({
          type: "tool-result",
          toolCallId: block.toolCallId,
          content: [{ type: "text", text: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "") }],
          ...(block.isError === true ? { isError: true } : {}),
        });
        return;
      case "image": {
        const data = block.data;
        // 每个 delta/derive 都可能跑到这里：同一 base64 只解码一次（尺寸与字节数共用）
        const buffer = data === undefined ? undefined : Buffer.from(data, "base64");
        const dimensions = buffer === undefined ? undefined : imageDimensions(block.mediaType, buffer);
        result.push({
          type: "image",
          attachment: {
            // 与 session/attachment 同一编号方案（<messageId>#<index>）
            attachmentId: `${message.id}#${index}`,
            mediaType: block.mediaType,
            bytes: buffer?.byteLength ?? 0,
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
          },
          ...(data === undefined ? {} : { offloaded: true }),
        });
        return;
      }
      case "video":
        // dsh 无视频块：降级为文本占位（用户/模型都能看到「此处有视频」，不静默吞掉）
        result.push({ type: "text", text: `[视频附件：${block.mediaType}${block.data === undefined ? "（仅落盘引用）" : ""}]` });
        return;
      case "web_search_call":
        // dsh 无联网搜索块：降级为文本占位（含服务端 item id，便于对照）
        result.push({ type: "text", text: `[联网搜索：${block.id}]` });
        return;
      default:
        return;
    }
  });
  return result;
}

/**
 * 消息的模型归属（会话级 provider/model）：`assistant/message.message.source` 的
 * `provider`/`model` 是 vendor UI 的**必读字段**（`dsh-client-ui-chat` 的 `messageRoute()` 直接
 * `message.source.provider.length`），缺失即整条会话渲染抛错。owc 消息不逐条记录归属，
 * 用会话当前 provider/model 投影（会话内切模型时历史条目的归属如实取当前值——比留白崩溃好，
 * 也与「模型徽标」的展示意图一致）。
 */
export interface DshMessageAttribution {
  provider: string;
  model: string;
}

/** 无归属信息时的兜底：空串（vendor 侧 `messageRoute` 对空串返回 undefined = 不显示徽标）。 */
const NO_ATTRIBUTION: DshMessageAttribution = { provider: "", model: "" };

/** 一条消息产生的 wire 事件（turn/step 由调用方给出）；surface-eligible 的事件带 surfaceOp。 */
function eventsForMessage(
  message: ChatMessage,
  turn: number,
  step: number,
  attribution: DshMessageAttribution = NO_ATTRIBUTION,
): Array<{ type: string; time: number; data: unknown; surfaceOp?: "append" }> {
  const time = Date.parse(message.createdAt) || 0;
  if (message.role === "assistant") {
    // 先补 tool/call（顺序与真实会话一致：调用先于汇总消息），再发汇总消息
    const calls = message.content
      .filter((block): block is Extract<MessageContent, { type: "tool_call" }> => block.type === "tool_call")
      .map((block) => ({
        type: "tool/call",
        time,
        data: { turn, step, callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
    return [
      ...calls,
      {
        type: "assistant/message",
        surfaceOp: SURFACE_APPEND,
        time,
        data: {
          turn,
          step,
          message: {
            id: message.id,
            role: "assistant",
            content: toDshBlocks(message, message.content),
            // 产出方归属：provider/model 必填（vendor UI 直接读 .length）；owc 不逐条记录，用会话级归属
            source: { kind: "model", provider: attribution.provider, model: attribution.model },
          },
          // 精确增量打包（assistant-stream）v1 为空数组：不编造 token 级增量
          stream: [],
        },
      },
    ];
  }
  // user / tool 两类：user 消息是普通提示，tool 消息承载工具结果
  if (message.role === "tool") {
    return [{
      type: "tool/result",
      surfaceOp: SURFACE_APPEND,
      time,
      data: {
        turn,
        step,
        message: {
          id: message.id,
          role: "user",
          content: toDshBlocks(message, message.content),
          source: { kind: "tool", callId: firstToolCallId(message) },
        },
      },
    }];
  }
  return [{
    type: "user/message",
    surfaceOp: SURFACE_APPEND,
    time,
    data: {
      id: message.id,
      role: "user",
      content: toDshBlocks(message, message.content),
      source: { kind: "user" },
    },
  }];
}

function firstToolCallId(message: ChatMessage): string {
  for (const block of message.content) {
    if (block.type === "tool_result") return block.toolCallId;
  }
  return message.id;
}

/**
 * 全量派生（确定性）：同一消息列表必得同一 seq 序列，因此快照与分页的 cursor 天然一致。
 * seq **从 0 起**连续：vendor 客户端的分页日志 `emptyCursor = -1`、`follows(l, r) = r === l + 1`
 * （dsh-api-gateway/client.js RemoteJournalStream + session-controller 的 first/last=event.seq），
 * 空会话快照 cursor 必须为 -1、首条记录 seq 必须为 0，否则首帧校验
 * 「page did not end at its requested cursor」直接拒收。
 * @returns records（seq 从 0 起连续）与每条记录所属的消息下标（用于按 maxMessages 切窗口）。
 */
export function deriveSessionRecords(
  messages: readonly ChatMessage[],
  attribution: DshMessageAttribution = NO_ATTRIBUTION,
  closeLastTurn = true,
): { records: DshWireRecord[]; messageStarts: number[] } {
  const records: DshWireRecord[] = [];
  const messageStarts: number[] = [];
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  const push = (type: string, time: number, data: unknown, surfaceOp?: "append"): void => {
    records.push({ type: "event", event: { type, seq: records.length, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } });
  };
  for (const message of messages) {
    const isPrompt = message.role === "user";
    if (isPrompt) {
      if (turnOpen) {
        push("step/end", Date.parse(message.createdAt) || 0, { turn, step });
        push("turn/end", Date.parse(message.createdAt) || 0, { turn, reason: TURN_END_COMPLETED });
      }
      turn++;
      step = 1;
      turnOpen = true;
      messageStarts.push(records.length);
      push("turn/start", Date.parse(message.createdAt) || 0, { turn });
      push("step/start", Date.parse(message.createdAt) || 0, { turn, step });
    } else {
      if (!turnOpen) {
        // 历史以 assistant/tool 开头（例如被截断的窗口）：补一个空 turn 承载，避免事件挂在 turn 0
        turn++;
        step = 1;
        turnOpen = true;
      }
      messageStarts.push(records.length);
    }
    for (const event of eventsForMessage(message, turn, step, attribution)) push(event.type, event.time, event.data, event.surfaceOp);
  }
  // 末轮的收尾记录只在**回合确实结束**时才追加（`closeLastTurn`）。
  //
  // 这是 append-only 稳定性的硬要求：回合进行中若先发 step/end + turn/end，等 assistant 消息落盘后
  // 同一 seq 位置会被重新解释成 assistant/message，客户端按 seq 去重时会把真正的回复吞掉
  // （表现为「问了没反应、刷新才出现」）。因此运行中的末轮保持「未收尾」，收尾记录随回合结束
  // 作为**尾部追加**出现——已下发记录的 seq 永不变动。
  if (turnOpen && closeLastTurn) {
    const last = messages[messages.length - 1];
    const time = last === undefined ? 0 : Date.parse(last.createdAt) || 0;
    push("step/end", time, { turn, step });
    push("turn/end", time, { turn, reason: TURN_END_COMPLETED });
  }
  return { records, messageStarts };
}

/**
 * 消息列表派生出的记录条数（= 末条记录的 seq + 1），不物化事件。
 *
 * 口径与 {@link deriveSessionRecords} 的 seq 编号严格一致（有等价性测试）；会话列表/控制基线
 * 只读尾部 50 条消息，为了不为此解析图片字节等重活，这里用计数推导而不是重跑一遍事件投影。
 * `projections.asOfSeq` 是「水位 seq」（末条记录 seq，空会话 -1），用 {@link sessionLastSeq} 取，
 * 与 follow cursor / page cursor 同一口径，否则客户端比较投影权威性时误判。
 */
export function sessionRecordsCount(messages: readonly ChatMessage[], closeLastTurn = true): number {
  let records = 0;
  let turnOpen = false;
  for (const message of messages) {
    const own = message.role === "assistant"
      ? 1 + message.content.filter((block) => block.type === "tool_call").length
      : 1;
    if (message.role === "user") {
      // 上一轮未收尾时先补 step/end + turn/end（与 deriveSessionRecords 一致）
      if (turnOpen) records += 2;
      records += 2 + own; // turn/start + step/start + 本条消息的事件
      turnOpen = true;
      continue;
    }
    // assistant / tool：历史被截断（无前置 user）时补一个空 turn，但不额外发 turn/start、step/start
    turnOpen = true;
    records += own;
  }
  if (turnOpen && closeLastTurn) records += 2;
  return records;
}

/**
 * 当前（末轮）回合的 turn/step：流式 attempt 的 start 帧必须与随后 assistant/message 记录的
 * `data.turn/step` 一致（vendor 客户端按二者匹配结算），因此这里从同一套派生规则里取。
 */
export function currentTurnStep(messages: readonly ChatMessage[]): { turn: number; step: number } {
  const { records } = deriveSessionRecords(messages);
  let turn = 1;
  let step = 1;
  for (const record of records) {
    if (record.event.type === "turn/start") {
      const value = (record.event.data as { turn?: unknown }).turn;
      if (typeof value === "number") turn = value;
      step = 1;
      continue;
    }
    if (record.event.type === "step/start") {
      const value = (record.event.data as { step?: unknown }).step;
      if (typeof value === "number") step = value;
    }
  }
  return { turn, step };
}

/** 末条记录的 seq（水位口径，空会话 = -1 = vendor 的 emptyCursor）。 */
export function sessionLastSeq(messages: readonly ChatMessage[], closeLastTurn = true): number {
  return sessionRecordsCount(messages, closeLastTurn) - 1;
}

/** 快照：取末尾 `maxMessages` 条消息对应的记录（seq 与全量派生一致，分页 cursor 不会错位）。 */
export function snapshotWindow(
  messages: readonly ChatMessage[],
  maxMessages: number | undefined,
  attribution: DshMessageAttribution = NO_ATTRIBUTION,
  closeLastTurn = true,
): {
  records: DshWireRecord[];
  hasMore: boolean;
  cursor: number;
  totalRecords: number;
} {
  const { records, messageStarts } = deriveSessionRecords(messages, attribution, closeLastTurn);
  const limit = maxMessages !== undefined && Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 50;
  const startIndex = Math.max(0, messages.length - limit);
  const startRecord = messageStarts[startIndex] ?? 0;
  const windowRecords = records.slice(startRecord);
  return {
    records: windowRecords,
    hasMore: startIndex > 0,
    // 空会话水位 = -1（vendor emptyCursor）：客户端 assertPageThrough 要求 tail === cursor，
    // 空记录数组的 tail 恒为 -1，这里回 0 会被直接拒收
    cursor: records[records.length - 1]?.event.seq ?? -1,
    totalRecords: records.length,
  };
}

/**
 * 向前翻旧历史（`session/page`）。两种口径：
 * - 带 `beforeSeq`（loadOlder/loadThrough  prepend）：取 seq < beforeSeq 的旧记录（左开）。
 * - 不带 `beforeSeq`（断流修复 replaceThrough）：必须**恰好止于 throughSeq（含）**——
 *   客户端 `assertPageThrough` 要求页尾 cursor 与请求的 through 严格相等，差一即协议违规。
 */
export function pageWindow(
  messages: readonly ChatMessage[],
  throughSeq: number,
  beforeSeq: number | undefined,
  maxMessages: number | undefined,
  attribution: DshMessageAttribution = NO_ATTRIBUTION,
  closeLastTurn = true,
): {
  records: DshWireRecord[];
  hasMore: boolean;
} {
  const { records, messageStarts } = deriveSessionRecords(messages, attribution, closeLastTurn);
  const limit = maxMessages !== undefined && Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 50;
  const upper = beforeSeq ?? throughSeq + 1;
  // 只保留 seq < upper 的记录
  const eligible = records.filter((record) => record.event.seq < upper);
  if (eligible.length === 0) return { records: [], hasMore: false };
  const lastSeq = eligible[eligible.length - 1]?.event.seq ?? 0;
  // 找到 lastSeq 所在消息的下标，往前取 limit 条消息
  let index = 0;
  for (let cursor = 0; cursor < messageStarts.length; cursor++) {
    const start = messageStarts[cursor] ?? 0;
    if ((records[start]?.event.seq ?? Number.MAX_SAFE_INTEGER) <= lastSeq) index = cursor;
  }
  const startIndex = Math.max(0, index - limit + 1);
  const startRecord = messageStarts[startIndex] ?? 0;
  const endRecord = (messageStarts[index + 1] ?? records.length);
  return {
    records: records.slice(startRecord, endRecord).filter((record) => record.event.seq < upper),
    hasMore: startIndex > 0,
  };
}
