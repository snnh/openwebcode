/**
 * 输入历史回查的数据源：从会话已加载消息中提取用户消息文本（最新在前）。
 * 供 Composer 的 ↑/↓ 回查使用。
 */
import type { ChatMessage } from "./contracts";

/** 用户消息的纯文本内容（拼接 text 块，去掉空消息） */
function userMessageText(message: ChatMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/** 会话消息 → 输入历史（仅 role=user，最新在前，空文本跳过） */
export function deriveInputHistory(messages: readonly ChatMessage[]): string[] {
  const history: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = userMessageText(message);
    if (text) history.push(text);
  }
  return history;
}
