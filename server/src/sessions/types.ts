export type MessageRole = "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  signature?: string;
  /** Anthropic redacted_thinking 块的密文载荷（此时 text 为空）：原样持久化并回传，缺块会 400。 */
  redacted?: string;
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
  /** spawn_task/spawn_swarm 产生的子代理转录 id（<contextRoot>/subagents/<taskId>.json），供 UI 查看转录。 */
  subagentTaskIds?: string[];
  /** spawn_task/spawn_swarm 逐项终态（index 显式对应 swarm item 序号，spawn_task 恒为 0）；部分失败/中断后刷新仍可还原每项状态。 */
  subagentTasks?: Array<{ taskId: string; index: number; status: "done" | "failed"; error?: string }>;
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

export type PermissionMode = "ask" | "acceptEdits" | "review" | "yolo";
/** review 权限模式的审核模型来源：fast = 快速模型；main = 会话当前 provider/model。 */
export type ReviewModel = "fast" | "main";
export interface PermissionRule { tool: string; argumentPrefix?: string }
/** 托管工作区元数据：会话项目目录活在隔离视图（VHDX/qcow2 镜像盘挂载点 / overlayfs merged）上 */
export interface ManagedWorkspaceMeta {
  mode: "managed";
  /** overlayfs = Linux merged 视图（lower=源目录只读，upper 捕获变更） */
  backend: "vhdx" | "qcow2" | "overlayfs";
  originCwd: string;
  /** vhdx/qcow2：基盘镜像路径；overlayfs：stateRoot（<sessionRoot>/overlay） */
  image: string;
  mountPoint: string;
}
/** 下发给 core 的 sandbox.mode（wsb 不下发，由 VM 充当边界；landlock 为 POSIX 默认语义，不下发 mode） */
export type SandboxBackendMode = "appcontainer" | "jobobject" | "landlock" | "bubblewrap" | "off";
/** 用户可选的沙盒模式；undefined = jobobject（Windows 现状默认）/ landlock（POSIX 现状默认） */
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "landlock" | "bubblewrap" | "off";
/** 沙盒网络策略：filtered = core 侧按规则过滤（仅 Windows；Landlock 无网络语义） */
export type SandboxNetwork = "allow" | "deny" | "filtered";
/** 自动 = 每轮用户消息前创建检查点；手动 = 仅由用户显式创建检查点。 */
export type SnapshotMode = "auto" | "manual";
/** 命令解释器后端（用户选择）；default 按平台探测顺序解析：Windows pwsh > Git Bash > cmd，POSIX bash > pwsh > $SHELL。 */
export type ShellBackend = "default" | "pwsh" | "bash" | "cmd";
/** 下发 core exec.run / job.start 的 shellBackend（协议枚举；cmd 映射为 default，bash 另随 shellPath 传绝对路径）。 */
export type CoreShellBackend = "default" | "pwsh" | "bash";
/** Python 运行环境：global = 本机已有环境（默认）；uv-workspace / uv-config = uv 管理的临时虚拟环境（项目工作区 / 配置目录）。 */
export type PythonEnv = "global" | "uv-workspace" | "uv-config";
/** Node 运行环境：global = 本机已有环境（默认）；project = 工作区 node_modules/.bin 前置 PATH；fnm / nvm = 版本管理器激活。 */
export type NodeEnv = "global" | "project" | "fnm" | "nvm";
/** 全局 Job Object 资源限制（仅 Windows；字段缺省时 core 用内置默认值 4096 MB / 64 进程） */
export interface JobObjectLimits {
  memoryMB?: number;
  maxProcesses?: number;
}
/** 会话级 Bind Link 目录绑定（Windows 11 24H2+，bindflt；virtPath 必须落在会话 writeRoots 内，backingPath 必须是已存在目录；创建需管理员权限）。仅显式配置时下发 core。 */
export interface BindLinkSpec {
  virtPath: string;
  backingPath: string;
  readOnly?: boolean;
}
export interface SandboxPolicy {
  enabled: boolean;
  readRoots: string[];
  writeRoots: string[];
  /** AppContainer 额外可写目录；core 会与 cwd 合并、规范化并去重。 */
  allowPaths?: string[];
  denyPaths: string[];
  network: SandboxNetwork;
  /** filtered 网络档：sidecar 代理地址（host:port），由 server 编排层在 configure 时补发。 */
  proxyAddr?: string;
  /** 通用只读授予（≤16；Windows 只读 ACL / Linux 只读规则），filtered 档用于放行 node/sidecar 脚本目录。 */
  readOnlyPaths?: string[];
  mode?: SandboxBackendMode;
  /** 可选 Job Object 覆盖（正整数，上限 1048576 MB / 4096 进程）；不下发时 core 用默认值 */
  jobMemoryMB?: number;
  jobMaxProcesses?: number;
  /** 可选 Bind Link 目录绑定（面向 jobobject/appcontainer 模式；wsb 会话不下发，宿主路径在 VM 内无效）。 */
  bindLinks?: BindLinkSpec[];
}

/** 会话级备选模型（fallback 链）条目：主模型在 run 中可恢复错误重试耗尽后按序切换。 */
export interface FallbackModelEntry {
  provider: string;
  model: string;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  /** 备选模型链（最多 3 个，校验时剔除与主模型重复或彼此重复项）；仅主循环 run 生效，子代理不继承（子代理走角色模型链）。 */
  fallbackModels?: FallbackModelEntry[];
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  agentMode?: "plan" | "code" | "goal";
  permissionMode?: PermissionMode;
  /** review 模式的审核模型来源；undefined = fast。 */
  reviewModel?: ReviewModel;
  permissionRules?: PermissionRule[];
  sandbox?: SandboxPolicy;
  /** 用户选择的沙盒模式；undefined = jobobject（现状默认） */
  sandboxMode?: SandboxMode;
  /** WSB 会话初始化脚本，内联进 .wsb LogonCommand，先于 owc-exec 执行 */
  setupScript?: string;
  /** 探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"），由 snapshots/index.ts 落盘 */
  snapshotBackend?: string;
  /** 快照创建模式；undefined 为向后兼容的自动模式。 */
  snapshotMode?: SnapshotMode;
  /** 命令解释器；undefined 为向后兼容的 default。 */
  shellBackend?: ShellBackend;
  /** Python 运行环境；undefined = 跟随全局默认（settings 的 pythonEnv，缺省本机环境）。 */
  pythonEnv?: PythonEnv;
  /** Node 运行环境；undefined = 跟随全局默认（settings 的 nodeEnv，缺省本机环境）。 */
  nodeEnv?: NodeEnv;
  /** env-sim 人格预设 id（会话级覆盖）；undefined = 跟随扩展全局 config.persona。 */
  persona?: string;
  /** 会话级扩展状态（key=扩展 id，value 为该扩展自定义的 JSON 对象）；通用化替代官方扩展私货字段。 */
  extensionState?: Record<string, Record<string, unknown>>;
  /** 并行子代理（spawn_swarm）开关；true = 注入工具与鼓励段落，undefined/false = 关闭。 */
  swarmEnabled?: boolean;
  /** 会话级内置工具白名单：非空 = 仅暴露名单内内置工具（交互类工具始终保留；未知名静默忽略）。 */
  toolsAllow?: string[];
  /** 会话级内置工具黑名单：在 toolsAllow 结果上再剔除（同样不触及交互类与 MCP/扩展工具）。 */
  toolsDeny?: string[];
  /** 选择性上下文（§4.4）：pin 的消息 id/文件路径（不被驱逐）。 */
  contextPins?: string[];
  /** 上下文排除路径 glob（不进上下文组装/repo map/索引；不是安全边界）。 */
  contextExcludes?: string[];
  /** repo map 自动注入开关；undefined = 开（§4.1 默认开，会话可关）。 */
  repoMapEnabled?: boolean;
  /** repo map token 预算；undefined = 2048（DEFAULT_REPO_MAP_BUDGET）。 */
  repoMapBudget?: number;
  /** 托管工作区：cwd 指向稀疏镜像盘挂载点，originCwd 为创建时的复制来源（plan §6.4） */
  workspace?: ManagedWorkspaceMeta;
  title: string;
  /** 会话列表置顶；缺省/undefined = 不置顶。 */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Current history leaf; absent means a legacy linear session. */
  activeLeafId?: string;
  /** Derived on read when messages.jsonl was recovered or needs attention. Never persisted to meta.json. */
  recovery?: { state: "recovered" | "needs_repair"; message: string };
}

export interface SessionDetail extends SessionMeta {
  messages: ChatMessage[];
  /** Total message count in messages.jsonl (may exceed messages.length when paginated) */
  messageCount?: number;
  /** Whether older messages exist beyond the returned page */
  hasMoreMessages?: boolean;
}

/** Paginated message page returned by GET /api/sessions/:id/messages */
export interface MessagesPage {
  messages: ChatMessage[];
  hasMore: boolean;
  totalLines: number;
}
