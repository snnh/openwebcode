import type { ChatMessage } from "./message";
import type { FallbackModelEntry, PermissionMode } from "./misc";
import type { ManagedWorkspace, NodeEnv, PythonEnv, SandboxMode, SandboxNetwork, ShellBackend } from "./sandbox";
import type { SnapshotMode } from "./snapshot";

export interface Session {
  id: string;
  cwd: string;
  /** 本机会话标记：cwd=HOME、sandboxMode=off（命令直跑宿主机），HOME 外文件路径走人工审批门。 */
  kind?: "local";
  provider: string;
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  agentMode?: "plan" | "code" | "goal";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  /** 沙盒内只读挂载 ~/.ssh；undefined/false = 不挂载（默认关闭，防私钥经沙盒命令外泄）。 */
  sshCredentials?: boolean;
  snapshotMode?: SnapshotMode;
  shellBackend?: ShellBackend;
  pythonEnv?: PythonEnv;
  nodeEnv?: NodeEnv;
  /** Agent 预设 id（会话级覆盖）；undefined = 跟随扩展全局配置；`classic` = 强制经典模式。 */
  preset?: string;
  /** 旧字段（env-sim 人格预设）；仅读取兼容。 */
  persona?: string;
  /** 并行子代理（spawn_swarm）开关；undefined/false = 关闭。 */
  swarmEnabled?: boolean;
  /** 会话级内置工具白名单/黑名单（仅内置工具名；undefined = 不限制）。 */
  toolsAllow?: string[];
  toolsDeny?: string[];
  /** 会话级备选模型链（最多 3 个；主模型可恢复错误重试耗尽后按序切换）。 */
  fallbackModels?: FallbackModelEntry[];
  setupScript?: string;
  /** 选择性上下文：pin 的消息 id/文件路径（不被驱逐）。 */
  contextPins?: string[];
  /** 上下文排除路径 glob（不是安全边界）。 */
  contextExcludes?: string[];
  sandbox?: {
    enabled: boolean;
    readRoots: string[];
    writeRoots: string[];
    /** AppContainer 额外可写目录（仅显式配置时存在）。 */
    allowPaths?: string[];
    denyPaths: string[];
    network: SandboxNetwork;
    /** 下发给 core 的沙盒后端模式（仅显式配置时存在）。 */
    mode?: string;
    /** 可选 Job Object 覆盖（仅显式配置时存在）。 */
    jobMemoryMB?: number;
    jobMaxProcesses?: number;
    /** 可选 Bind Link 目录绑定（Windows 11 24H2+；仅显式配置时存在）。 */
    bindLinks?: { virtPath: string; backingPath: string; readOnly?: boolean }[];
  };
  workspace?: ManagedWorkspace;
  title: string;
  /** 会话列表置顶（PATCH /api/sessions/:id）。 */
  pinned?: boolean;
  /** 手工标签组名（PATCH /api/sessions/:id 的 group；undefined = 未分组）。 */
  group?: string;
  /** 已归档：不在默认列表显示（详见 help/usage.md「会话组织」）。 */
  archived?: boolean;
  /**
   * 待办标记（GET /api/sessions 服务端聚合，仅在有值时出现）：该会话正等着你回答。
   * permissions = 待审批权限数，interactions = 待答交互（ask_user/计划批准）数。
   */
  attention?: { permissions: number; interactions: number };
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends Session {
  messages: ChatMessage[];
  /** Total message count in messages.jsonl (may exceed messages.length when paginated) */
  messageCount?: number;
  /** Whether older messages exist beyond the returned page */
  hasMoreMessages?: boolean;
  /** 当前生效的 Agent 预设（会话级覆盖优先；扩展未启用/未配置为空表示经典模式）。 */
  activePreset?: PresetSummary | null;
}

export type PresetCategory = "minimal" | "mimicry" | "custom";
export type PresetPromptStyle = "classic" | "minimal";
export type PresetProjectContext = "paths" | "content" | "none";

/** Agent 预设摘要（清单/生效标识；overridden = 内置预设存在用户覆盖，当前生效的是合并版）。 */
export interface PresetSummary {
  id: string;
  name: string;
  description: string;
  category: PresetCategory;
  builtin: boolean;
  overridden?: boolean;
}

/** Agent 预设完整详情（选前预览与编辑器回填）。 */
export interface PresetDetail extends PresetSummary {
  identity: string;
  basePrompt: string;
  productSections: string[];
  hideBuiltIns: string[];
  aliases: PresetAlias[];
  /** 白名单：非空时只保留这些内置工具；优先于 hideBuiltIns。 */
  allowedBuiltIns?: string[];
  /** 提示词形态：classic=现有完整框架；minimal=精简模式专用裁剪。 */
  promptStyle?: PresetPromptStyle;
  /** 项目上下文：paths=全局记忆注入+工作区文件只列路径；content=经典全量；none=不注入。 */
  projectContext?: PresetProjectContext;
  /** 是否允许扩展/MCP 工具进入工具表。 */
  externalTools?: boolean;
  /** 逐工具描述覆盖（键为内置工具名）。 */
  toolDescriptions?: Record<string, string>;
  /** 首轮（会话首个模型调用）只注入这些内置工具（模型侧别名后名），其余内置保持隐藏。 */
  firstTurnOnlyTools?: string[];
  /** /init 命令展开提示词拟态（可选）。 */
  initPrompt?: string;
  /** /compact（overview）压缩系统提示词拟态（可选）。 */
  compactOverviewPrompt?: string;
  /** /compact tools 压缩系统提示词拟态（可选）。 */
  compactToolcallsPrompt?: string;
  /** 出站 User-Agent 拟态值（仅扩展 simulateUserAgent 开启且选为全局预设时生效）。 */
  userAgent?: string;
}

/** 工具形态别名（与 server PresetAlias 对齐）。 */
export interface PresetAlias {
  from: string;
  as: string;
  description?: string;
  /** 模型可见的输入 schema 覆盖（拟态目标产品的参数形态）。 */
  inputSchema?: Record<string, unknown>;
  /** 参数名归一：模型侧参数名 -> 内置工具参数名。未列出的键原样透传。 */
  argMap?: Record<string, string>;
}

/** 新建/编辑 Agent 预设的提交体（同 id 覆盖即编辑）。 */
export interface PresetInput {
  id: string;
  name: string;
  description?: string;
  category?: PresetCategory;
  identity: string;
  basePrompt: string;
  productSections?: string[];
  allowedBuiltIns?: string[];
  hideBuiltIns?: string[];
  promptStyle?: PresetPromptStyle;
  projectContext?: PresetProjectContext;
  externalTools?: boolean;
  toolDescriptions?: Record<string, string>;
  aliases?: PresetAlias[];
  firstTurnOnlyTools?: string[];
  initPrompt?: string;
  compactOverviewPrompt?: string;
  compactToolcallsPrompt?: string;
  userAgent?: string;
}

/** 工具目录（精简模式编辑器供数）。 */
export interface PresetToolInfo {
  name: string;
  label: string;
  labelEn: string;
  group: "core" | "web" | "media" | "interaction" | "git" | "analysis" | "orchestration" | "workflow" | "external";
  description: string;
  optional?: boolean;
  advancedOnly?: boolean;
  required?: boolean;
  defaultEnabled?: boolean;
}

export interface PresetToolGroup {
  id: PresetToolInfo["group"];
  label: string;
  labelEn: string;
  tools: string[];
  defaultEnabled: boolean;
}

/** 0.5.0 Phase 2: paginated message page from GET /api/sessions/:id/messages */
export interface MessagesPage {
  messages: ChatMessage[];
  hasMore: boolean;
  totalLines: number;
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface InteractionRequest {
  id: string; sessionId: string; runId: string; toolCallId?: string;
  kind: "confirm" | "single_select" | "multi_select" | "text" | "plan_approval";
  title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }>;
  /** 选择题附加「其他」选项：渲染「其他」+ 自定义文本输入框，回答以 other:<文本> 表示。 */
  allowOther?: boolean;
  status: "pending" | "answered" | "cancelled"; createdAt: string; answer?: unknown; answeredAt?: string;
}

// 会话树节点：entries 含全部树节点（按时间排序），onActivePath 标记是否在当前活动路径上（分叉/检出后为非活动分支）
export interface SessionTimeline { activeLeafId?: string; entries: Array<{ id: string; parentId?: string; runId?: string; turnId?: string; role: "user" | "assistant" | "tool"; createdAt: string; onActivePath?: boolean }>; }
export interface QueueItem { id: string; sessionId: string; kind: "steer" | "follow_up"; content: string; status: "queued" | "consuming" | "applied" | "cancelled"; createdAt: string; updatedAt: string; }
