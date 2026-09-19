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
  };
}

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
        const dimensions = data === undefined ? undefined : imageDimensions(block.mediaType, Buffer.from(data, "base64"));
        result.push({
          type: "image",
          attachment: {
            // 与 session/attachment 同一编号方案（<messageId>#<index>）
            attachmentId: `${message.id}#${index}`,
            mediaType: block.mediaType,
            bytes: data === undefined ? 0 : Buffer.from(data, "base64").byteLength,
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

/** 一条消息产生的 wire 事件（turn/step 由调用方给出）。 */
function eventsForMessage(message: ChatMessage, turn: number, step: number): Array<{ type: string; time: number; data: unknown }> {
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
        time,
        data: {
          turn,
          step,
          message: {
            id: message.id,
            role: "assistant",
            content: toDshBlocks(message, message.content),
            // 产出方归属：owc 消息不带 provider/model，按会话级信息无法逐条还原，留空如实
            source: { kind: "model" },
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
 * @returns records（seq 从 1 起连续）与每条记录所属的消息下标（用于按 maxMessages 切窗口）。
 */
export function deriveSessionRecords(messages: readonly ChatMessage[]): { records: DshWireRecord[]; messageStarts: number[] } {
  const records: DshWireRecord[] = [];
  const messageStarts: number[] = [];
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  const push = (type: string, time: number, data: unknown): void => {
    records.push({ type: "event", event: { type, seq: records.length + 1, time, data } });
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
    for (const event of eventsForMessage(message, turn, step)) push(event.type, event.time, event.data);
  }
  if (turnOpen) {
    const last = messages[messages.length - 1];
    const time = last === undefined ? 0 : Date.parse(last.createdAt) || 0;
    push("step/end", time, { turn, step });
    push("turn/end", time, { turn, reason: TURN_END_COMPLETED });
  }
  return { records, messageStarts };
}

/** 快照：取末尾 `maxMessages` 条消息对应的记录（seq 与全量派生一致，分页 cursor 不会错位）。 */
export function snapshotWindow(messages: readonly ChatMessage[], maxMessages: number | undefined): {
  records: DshWireRecord[];
  hasMore: boolean;
  cursor: number;
  totalRecords: number;
} {
  const { records, messageStarts } = deriveSessionRecords(messages);
  const limit = maxMessages !== undefined && Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 50;
  const startIndex = Math.max(0, messages.length - limit);
  const startRecord = messageStarts[startIndex] ?? 0;
  const windowRecords = records.slice(startRecord);
  return {
    records: windowRecords,
    hasMore: startIndex > 0,
    cursor: records[records.length - 1]?.event.seq ?? 0,
    totalRecords: records.length,
  };
}

/** 向前翻旧历史（`session/page`）：取 `throughSeq` 之前（不含）的 `maxMessages` 条消息记录。 */
export function pageWindow(messages: readonly ChatMessage[], throughSeq: number, beforeSeq: number | undefined, maxMessages: number | undefined): {
  records: DshWireRecord[];
  hasMore: boolean;
} {
  const { records, messageStarts } = deriveSessionRecords(messages);
  const limit = maxMessages !== undefined && Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 50;
  const upper = beforeSeq ?? throughSeq;
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
