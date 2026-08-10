/**
 * shell 快捷命令（user 消息 `!cmd` + 紧随的 tool_result 配对）的判定与提取。
 * ExecutionTrack（「发给 agent」按钮）与 TerminalView（终端标签历史）共用。
 */
import type { ChatMessage } from "./contracts";

/** 用户消息若以 `!` 开头则是 shell 快捷命令，返回命令文本（含 `!` 前缀）；否则 undefined */
export function shellCommandOf(message?: ChatMessage): string | undefined {
  if (!message || message.role !== "user") return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  return text.startsWith("!") ? text : undefined;
}

/** 工具消息的 tool_result 文本（shell 输出/错误） */
export function toolResultOf(message?: ChatMessage): string {
  if (!message || message.role !== "tool") return "";
  return message.content
    .filter((block) => block.type === "tool_result")
    .map((block) => block.content ?? "")
    .join("\n");
}
