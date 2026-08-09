// 聊天模式（Chat Mode）契约类型：统一以 lib/contracts.ts 为准（与 server 对齐），此处仅 re-export。
export type {
  ChatMessage,
  MessageContent,
  ChatSessionMeta,
  ChatShare,
  ChatAssistant,
  ChatConfig,
  ChatModelEntry,
  ChatStreamEvent,
  ChatSessionDetail,
} from "../lib/contracts";
