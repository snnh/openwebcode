export type MessageRole = "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: MessageContent[];
  createdAt: string;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
}
