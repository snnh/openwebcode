import type { ChatMessage } from "../lib/contracts";
import type { useI18n } from "../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

/** 条目/断点摘要：取消息首个可展示块（工具名/结果/文本）截断为单行。 */
export function messageSummary(messages: ChatMessage[] | undefined, messageId: string, t: Translate): string {
  const message = messages?.find((item) => item.id === messageId);
  if (!message) return messageId;
  for (const block of message.content) {
    if (block.type === "tool_call" && block.name) return t(`工具 ${block.name}`, `Tool ${block.name}`);
    if (block.type === "tool_result" && block.content?.trim()) {
      const text = block.content.trim().replace(/\s+/g, " ");
      return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
    if (block.type === "text" && block.text?.trim()) {
      const text = block.text.trim().replace(/\s+/g, " ");
      return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
  }
  return messageId;
}
