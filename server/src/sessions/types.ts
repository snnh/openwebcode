export type MessageRole = "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  signature?: string;
  provider: string;
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

export type MessageContent = TextContent | ThinkingContent | ToolCallContent | ToolResultContent;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: MessageContent[];
  createdAt: string;
}

export type PermissionMode = "ask" | "acceptEdits" | "yolo";
export interface PermissionRule { tool: string; argumentPrefix?: string }
export interface SandboxPolicy {
  enabled: boolean;
  readRoots: string[];
  writeRoots: string[];
  denyPaths: string[];
  network: "allow" | "deny";
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  sandbox?: SandboxPolicy;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
}
