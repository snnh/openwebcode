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
  /** Optional lineage keeps legacy JSONL records readable without migration rewrites. */
  parentId?: string;
  runId?: string;
  turnId?: string;
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
/** 自动 = 每轮用户消息前创建检查点；手动 = 仅由用户显式创建检查点。 */
export type SnapshotMode = "auto" | "manual";
/** 命令解释器后端；default 使用平台默认 shell，pwsh 强制使用 PowerShell 7。 */
export type ShellBackend = "default" | "pwsh";
/** 全局 Job Object 资源限制（仅 Windows；字段缺省时 core 用内置默认值 4096 MB / 64 进程） */
export interface JobObjectLimits {
  memoryMB?: number;
  maxProcesses?: number;
}
export interface SandboxPolicy {
  enabled: boolean;
  readRoots: string[];
  writeRoots: string[];
  /** AppContainer 额外可写目录；core 会与 cwd 合并、规范化并去重。 */
  allowPaths?: string[];
  denyPaths: string[];
  network: "allow" | "deny";
  mode?: SandboxBackendMode;
  /** 可选 Job Object 覆盖（正整数，上限 1048576 MB / 4096 进程）；不下发时 core 用默认值 */
  jobMemoryMB?: number;
  jobMaxProcesses?: number;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  agentMode?: "plan" | "build";
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  sandbox?: SandboxPolicy;
  /** 用户选择的沙盒模式；undefined = appcontainer（现状默认） */
  sandboxMode?: SandboxMode;
  /** WSB 会话初始化脚本，内联进 .wsb LogonCommand，先于 owc-exec 执行 */
  setupScript?: string;
  /** 探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"），由 snapshots/index.ts 落盘 */
  snapshotBackend?: string;
  /** 快照创建模式；undefined 为向后兼容的自动模式。 */
  snapshotMode?: SnapshotMode;
  /** 命令解释器；undefined 为向后兼容的 default。 */
  shellBackend?: ShellBackend;
  /** 托管工作区：cwd 指向稀疏镜像盘挂载点，originCwd 为创建时的复制来源（plan §6.4） */
  workspace?: ManagedWorkspaceMeta;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Current history leaf; absent means a legacy linear session. */
  activeLeafId?: string;
  /** Derived on read when messages.jsonl was recovered or needs attention. Never persisted to meta.json. */
  recovery?: { state: "recovered" | "needs_repair"; message: string };
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
}
