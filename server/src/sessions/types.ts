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

/** 用户消息中的图片块（base64 内联，mediaType 限 image/png|jpeg|webp|gif）。 */
export interface ImageContent {
  type: "image";
  mediaType: string;
  data: string;
}

export type MessageContent = TextContent | ThinkingContent | ToolCallContent | ToolResultContent | ImageContent;

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
  /** 探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"），由 snapshots/index.ts 落盘 */
  snapshotBackend?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
}
