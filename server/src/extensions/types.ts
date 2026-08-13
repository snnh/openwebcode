import type { ChatMessage } from "../sessions/types.js";

export const EXTENSION_API_VERSION = "1";

export type ExtensionPermission =
  | "context:read"
  | "context:mutate"
  | "tools:register"
  | "sessions:read"
  | "ui:panel"
  | "ui:messageAttachment"
  | "network:fetch"
  | "http:route"
  | "model:fast"
  | "prompt:shape"
  | "tools:shaping";

export type ExtensionHook = "context.beforeBuild" | "tool.beforeExecute" | "message.beforeSend" | "prompt.beforeBuild";

/** 工具形态别名：把内置工具 from 以新名字 as 暴露给模型。 */
export interface ToolShapingAlias {
  from: string;
  as: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** 参数名归一：模型侧参数名 -> 内置工具参数名（配合 inputSchema 拟态外部产品参数形态）。 */
  argMap?: Record<string, string>;
}

/** 工具形态声明：隐藏内置工具 + 别名重命名。官方扩展直接声明；第三方扩展需 tools:shaping 权限。 */
export interface ToolShapingSpec {
  hideBuiltIns?: string[];
  aliases?: ToolShapingAlias[];
}

/** 扩展声明的私有 HTTP 路由（挂载在 /api/ext/<extensionId><path>）。 */
export interface ExtensionRoute {
  method: "GET" | "POST" | "DELETE";
  /** 以 / 开头，不允许 .. 段；与请求路径精确匹配。 */
  path: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  apiVersion: string;
  permissions: ExtensionPermission[];
  official?: boolean;
  defaultEnabled?: boolean;
  entry?: string;
  /** 配置表单的 JSON Schema 子集（type/properties/required/enum/default），供 UI 渲染与松散校验。 */
  configSchema?: Record<string, unknown>;
  /** 官方扩展可直接声明；第三方扩展需 tools:shaping 权限，否则拒绝（防止伪装内置工具）。 */
  toolShaping?: ToolShapingSpec;
  /** 私有 HTTP 路由表；声明时必须携带 http:route 权限。 */
  routes?: ExtensionRoute[];
}

export interface ExtensionState {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ExtensionInfo extends ExtensionManifest {
  enabled: boolean;
  builtIn: boolean;
  status: "running" | "disabled" | "error";
  config: Record<string, unknown>;
  error?: string;
  /** env-sim 专用：可选预设列表（内置 + 用户目录发现），供 UI 下拉渲染。 */
  availablePersonas?: Array<{ id: string; name: string; builtin: boolean }>;
}

export interface ContextHookPayload {
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  ledger: {
    round: number;
    entries: Array<{ messageId: string; state: string; pinnedUntilRound: number }>;
    compacted?: { summary: string; instructions: string[]; mode?: string };
  };
}

export interface ContextHookResult {
  messages?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface ToolHookPayload {
  sessionId: string;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolHookResult {
  input?: Record<string, unknown>;
  blocked?: boolean;
  reason?: string;
}

/** prompt.beforeBuild 载荷：basePrompt 是文件覆盖解析之后的基线。 */
export interface PromptHookPayload {
  sessionId: string;
  cwd: string;
  identity: string;
  basePrompt: string;
  productSections: string[];
  /** 会话级扩展状态（SessionMeta.extensionState，key=扩展 id），供扩展读取自己的会话级配置。 */
  extensionState?: Record<string, Record<string, unknown>>;
}

/** prompt.beforeBuild 结果：字段缺省表示保持不变；finalConstraints/安全边界由核心追加，不可经此移除。 */
export interface PromptHookResult {
  identity?: string;
  basePromptOverride?: string;
  productSections?: string[];
  prependSections?: string[];
}

export interface HostRequest {
  id: string;
  method: "initialize" | "reload" | "hook" | "tool.invoke" | "http.request" | "shutdown";
  params?: Record<string, unknown>;
}

export interface HostResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/** 扩展可调用的 server 能力（host→server ApiRequest.api）。 */
export type ExtensionApiMethod =
  | "sessions.list"
  | "sessions.get"
  | "context.getView"
  | "context.readArtifact"
  | "context.readVaultFile"
  | "context.readImageFile"
  | "events.subscribe"
  | "storage.read"
  | "storage.write"
  | "storage.delete"
  | "storage.list"
  | "model.complete"
  | "model.vision"
  | "models.getCapabilities";

/** host→server：扩展调用 server 能力。与 HostResponse 以 api+extensionId 字段区分。 */
export interface ApiRequest {
  id: string;
  api: ExtensionApiMethod;
  extensionId: string;
  params?: Record<string, unknown>;
}

/** server→host：ApiRequest 的应答（host 侧按 id 匹配挂起的调用）。 */
export interface ApiResponse {
  id: string;
  api: ExtensionApiMethod;
  result?: unknown;
  error?: string;
}

/** server→host：events.subscribe 订阅的 EventBus 事件推送（无应答）。 */
export interface EventMessage {
  event: string;
  sessionId?: string;
  payload: unknown;
}

/** 扩展注册的工具定义（initialize/reload 响应上报，注入 agent 工具表为 ext__<extensionId>__<name>）。 */
export interface ExtensionToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 工具执行超时（毫秒，默认 5000，上限 120000）；涉及模型调用等长耗时操作需显式调大。 */
  timeoutMs?: number;
}

/** 扩展工具执行结果（tool.invoke 的 HostResponse.result）。 */
export interface ExtensionToolResult {
  content: string;
  isError?: boolean;
}

/** 允许推送给扩展的事件类型：精确匹配（agent.state/tool.start/tool.end）或前缀（context./checkpoint./subagent.）。 */
export const EXTENSION_EVENT_WHITELIST: readonly string[] = ["agent.state", "tool.start", "tool.end", "context.", "checkpoint.", "subagent."];

export function isExtensionEventAllowed(type: string): boolean {
  return EXTENSION_EVENT_WHITELIST.some((entry) => (entry.endsWith(".") ? type.startsWith(entry) : type === entry));
}
