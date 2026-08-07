import type { ChatMessage } from "../lib/contracts";

/**
 * 消息分组纯函数（移植旧 ExecutionTrack 的轮次/过程段逻辑）：
 * - turnOf：一条 user 消息开启一轮，其后的 assistant/tool 归属该轮（首条 user 前为 0）。
 * - isProcess：tool 角色消息，或无正文 text 块的 assistant 消息（纯 thinking / 纯 tool_call）。
 * - buildRenderItems：会话空闲时连续过程消息段整体折叠为一个折叠组；
 *   clear 分隔线落在折叠段首时由调用方外置渲染（见 showDivider 注释）。
 */

export type RenderItem =
  | {
      kind: "message";
      index: number;
      /**
       * 是否在本条目前渲染 clear 分隔线（clearedLocal === index 时）。
       * 折叠段内条目的分隔线一律抑制——段首的由调用方外置到折叠组之前，
       * 段内深处的按旧行为不渲染（避免折进折叠区不可见）。
       */
      showDivider: boolean;
    }
  | {
      kind: "fold";
      /** 段内首条消息下标（含） */
      start: number;
      /** 段内末条消息下标（不含） */
      end: number;
      toolCalls: number;
      failed: boolean;
    };

export function turnOf(messages: ChatMessage[]): number[] {
  const values: number[] = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") turn += 1;
    values.push(turn);
  }
  return values;
}

export function isProcess(messages: ChatMessage[]): boolean[] {
  return messages.map((message) => {
    if (message.role === "tool") return true;
    if (message.role !== "assistant") return false;
    return !message.content.some((block) => block.type === "text" && (block.text ?? "").trim());
  });
}

export function buildRenderItems(
  messages: ChatMessage[],
  opts: { foldProcess: boolean; clearedLocal?: number },
): RenderItem[] {
  const process = isProcess(messages);
  const items: RenderItem[] = [];
  for (let index = 0; index < messages.length; ) {
    if (!opts.foldProcess || !process[index]) {
      items.push({ kind: "message", index, showDivider: true });
      index += 1;
      continue;
    }
    // 连续过程消息段 → 单个折叠组（原生 <details> 由调用方渲染，内容常驻 DOM 可被搜索）
    let end = index + 1;
    while (end < messages.length && process[end]) end += 1;
    let toolCalls = 0;
    let failed = false;
    for (let i = index; i < end; i += 1) {
      for (const block of messages[i]!.content) {
        if (block.type === "tool_call") toolCalls += 1;
        if (block.type === "tool_result" && block.isError) failed = true;
      }
    }
    items.push({ kind: "fold", start: index, end, toolCalls, failed });
    index = end;
  }
  return items;
}
