import type { ChatMessage } from "../sessions/types.js";

export const EXTENSION_API_VERSION = "1";

export type ExtensionPermission =
  | "context:read"
  | "context:mutate"
  | "tools:register"
  | "sessions:read"
  | "ui:panel"
  | "ui:messageAttachment"
  | "network:fetch";

export type ExtensionHook = "context.beforeBuild" | "tool.beforeExecute" | "message.beforeSend";

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
}

export interface ContextHookPayload {
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  ledger: {
    round: number;
    entries: Array<{ messageId: string; state: string; pinnedUntilRound: number }>;
    compacted?: { summary: string; instructions: string[] };
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

export interface HostRequest {
  id: string;
  method: "initialize" | "reload" | "hook" | "tool.invoke" | "shutdown";
  params?: Record<string, unknown>;
}

export interface HostResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/** 扩展可调用的 server 能力（host→server ApiRequest.api）。 */
export type ExtensionApiMethod = "sessions.list" | "sessions.get" | "context.getView" | "context.readArtifact" | "events.subscribe";

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
