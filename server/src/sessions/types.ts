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
/** 托管工作区元数据：会话项目目录活在稀疏镜像盘（VHDX/qcow2）挂载点上 */
export interface ManagedWorkspaceMeta {
  mode: "managed";
  backend: "vhdx" | "qcow2";
  originCwd: string;
  image: string;
  mountPoint: string;
}
/** 下发给 core 的 sandbox.mode（wsb 不下发，由 VM 充当边界） */
export type SandboxBackendMode = "appcontainer" | "jobobject" | "off";
/** 用户可选的沙盒模式；undefined = appcontainer（现状默认） */
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "off";
export interface SandboxPolicy {
  enabled: boolean;
  readRoots: string[];
  writeRoots: string[];
  denyPaths: string[];
  network: "allow" | "deny";
  mode?: SandboxBackendMode;
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
  /** 用户选择的沙盒模式；undefined = appcontainer（现状默认） */
  sandboxMode?: SandboxMode;
  /** WSB 会话初始化脚本，内联进 .wsb LogonCommand，先于 owc-exec 执行 */
  setupScript?: string;
  /** 探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"），由 snapshots/index.ts 落盘 */
  snapshotBackend?: string;
  /** 托管工作区：cwd 指向稀疏镜像盘挂载点，originCwd 为创建时的复制来源（plan §6.4） */
  workspace?: ManagedWorkspaceMeta;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
}
