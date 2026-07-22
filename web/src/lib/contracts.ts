export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

export type PermissionMode = "ask" | "acceptEdits" | "yolo";
export type SandboxCapability = "advisory" | "partial" | "enforced";
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "off";
export type SnapshotMode = "auto" | "manual";

export interface SandboxCapabilities {
  appcontainer: boolean;
  jobobject: boolean;
  off: boolean;
  wsb: { available: boolean; reason?: string };
}

/** 托管工作区平台能力（GET /api/managed-workspace/capability） */
export interface ManagedWorkspaceCapability {
  platform: string;
  backends: Array<{ backend: "vhdx" | "qcow2"; available: boolean; requiresAdmin: boolean; detail?: string }>;
}

/** 会话的镜像盘工作区元数据；源目录只会在用户确认手动同步时被写回。 */
export interface ManagedWorkspace {
  mode: "managed";
  backend: "vhdx" | "qcow2";
  originCwd: string;
  image: string;
  mountPoint: string;
}

/** 单个工作区条目的可比较状态；不向浏览器暴露绝对路径。 */
export interface ManagedWorkspaceSyncNode {
  kind: "file" | "directory" | "symlink" | "other";
  sha256?: string;
  size?: number;
  mode?: number;
}

export type ManagedWorkspaceSyncAction = "create" | "update" | "delete" | "none" | "conflict" | "unsupported";

/** 基线、源目录和镜像盘三方比较得到的一项变更。 */
export interface ManagedWorkspaceSyncChange {
  path: string;
  action: ManagedWorkspaceSyncAction;
  reason: string;
  baseline: ManagedWorkspaceSyncNode | null;
  origin: ManagedWorkspaceSyncNode | null;
  managed: ManagedWorkspaceSyncNode | null;
  originChanged: boolean;
  managedChanged: boolean;
}

export interface ManagedWorkspaceSyncPreview {
  baseline: { available: boolean; reason?: "missing" | "invalid"; createdAt?: string; version?: number };
  /** 预览为空基线时仍可由显式覆盖流程提供校验指纹。 */
  fingerprint: string | null;
  changes: ManagedWorkspaceSyncChange[];
  summary: { create: number; update: number; delete: number; conflicts: number; unsupported: number; unchanged: number };
}

export interface ManagedWorkspaceSyncResult {
  applied: Array<{ path: string; action: "create" | "update" | "delete" | "overwrite" }>;
  conflicts: ManagedWorkspaceSyncChange[];
  unsupported: ManagedWorkspaceSyncChange[];
  nextPreview: ManagedWorkspaceSyncPreview;
}

export interface MessageContent {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "image";
  text?: string;
  provider?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
  mediaType?: string;
  data?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: MessageContent[];
  createdAt: string;
}

export interface Session {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  agentMode?: "plan" | "build";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  snapshotMode?: SnapshotMode;
  setupScript?: string;
  sandbox?: {
    enabled: boolean;
    readRoots: string[];
    writeRoots: string[];
    denyPaths: string[];
    network: "allow" | "deny";
  };
  workspace?: ManagedWorkspace;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends Session {
  messages: ChatMessage[];
}

export interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface AppEvent {
  eventId?: string;
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  runId?: string;
  seq: number;
  sessionSeq?: number;
  createdAt: string;
  payload: unknown;
}

export type AgentRunState = "accepted" | "starting" | "snapshotting" | "preparing_context" | "streaming" | "executing_tools" | "waiting_permission" | "advancing_turn" | "settling" | "budget_paused" | "completed" | "failed" | "aborted";

/** Durable server-side run snapshot returned by GET /api/sessions/:id/run. */
export interface AgentRun {
  id: string;
  sessionId: string;
  triggerMessageId: string;
  state: AgentRunState;
  turnIndex: number;
  startedAt: string;
  since: string;
  settledAt?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ContextView {
  ledger: {
    round?: number;
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
    cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
    entries: Array<{ messageId: string; state: "full" | "evicted" | "restored"; artifactId: string; pinnedUntilRound?: number }>;
    policy?: {
      enabled: boolean;
      strategy: "lag" | "interval" | "off";
      lag: number;
      interval: number;
      pinExemptRounds: number;
      restoreBudget: number;
      maxSessionTokens?: number;
      maxSessionCost?: { currency: "USD" | "CNY"; microUnits: string };
    };
    compacted?: { uptoIndex: number; mode: "toolcalls" | "overview" | "truncated"; summary: string; instructions: string[]; createdAt: string };
    cleared?: { uptoIndex: number; at: string };
  };
  preferences: { language: string; currency: "USD" | "CNY"; currencyLabel: string };
}

export type ExtensionPermission = "context:read" | "context:mutate" | "tools:register" | "sessions:read" | "ui:panel" | "ui:messageAttachment" | "network:fetch";

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  apiVersion: string;
  permissions: ExtensionPermission[];
  official?: boolean;
  defaultEnabled?: boolean;
  enabled: boolean;
  builtIn: boolean;
  status: "running" | "disabled" | "error";
  config: Record<string, unknown>;
  error?: string;
}

export type ModelModality = "text" | "image" | "video";

export interface ModelCapabilities {
  /** Input modalities accepted by the model. */
  modalities: ModelModality[];
  /** Whether the model can return image content. */
  imageOutput: boolean;
  thinking: Array<"adaptive" | "enabled" | "disabled">;
  effort: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  tools: boolean;
}

export interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  source?: "builtin" | "api" | "synced" | "manual";
  contextWindow: number;
  maxOutput: number;
  capabilities: ModelCapabilities;
  pricing?: { currency: string; input: string; output: string; cacheRead: string; cacheWrite: string };
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
}

export interface SnapshotCapabilityInfo {
  backend: string;
  costHint: "instant" | "linear";
  requiresAdmin: boolean;
  detail?: string;
}

export interface PricingEntry {
  provider: string;
  model: string;
  currency: "USD" | "CNY";
  effectiveFrom: string;
  effectiveUntil?: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

export interface PricingDocument {
  version: 1;
  updatedAt: string;
  entries: PricingEntry[];
}

/** Result returned by a remote catalog or pricing synchronization attempt. */
export type SyncResult =
  | { ok: true; count: number; updatedAt: string }
  | { ok: false; error: string };

/** Persisted status of the remote model-catalog layer. */
export interface CatalogSyncStatus {
  count: number;
  updatedAt?: string;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
}

export type SettingFieldType = "text" | "secret" | "number" | "boolean" | "select" | "pathList";
export type SettingValue = string | number | boolean | string[];

export interface SettingsField {
  key: string;
  label: string;
  type: SettingFieldType;
  options?: string[];
  value: SettingValue | null;
  hasValue: boolean;
  masked?: string;
  source: "default" | "env" | "file";
  editable: boolean;
  restartRequired: boolean;
  nullable: boolean;
  description?: string;
}

export interface SettingsGroup {
  id: string;
  label: string;
  fields: SettingsField[];
}

export interface SettingsView {
  groups: SettingsGroup[];
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "global" | "project";
  path?: string;
}

export interface ReportMetrics {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  usdMicroUnits: string;
  cnyMicroUnits: string;
  unpricedTokens: number;
}

export type ProviderBreakdown = ReportMetrics & { provider: string; model: string };

export interface CostReport {
  generatedAt: string;
  from?: string;
  to?: string;
  totals: ReportMetrics;
  days: Array<ReportMetrics & { date: string; providers: ProviderBreakdown[] }>;
  sessions: Array<ReportMetrics & { sessionId: string; title?: string; providers: ProviderBreakdown[] }>;
  preferences: { currency: "USD" | "CNY" };
}

export interface BackgroundTaskInfo {
  taskId: string;
  sessionId: string;
  cmd: string;
  cwd: string;
  status: "running" | "done" | "failed" | "stopped";
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  output?: string;
  truncated?: boolean;
}

/** @文件引用：消息发送时附带的工作区文件路径，server 在 appendMessage 前读取并注入为前置 text 块 */
export interface MessageAttachment {
  path: string;
}

/** GET /api/sessions/:id/complete-path 响应：core.globFiles（模式 *q*）截断至 20 条 */
export interface CompletePathResponse {
  matches: Array<{ path: string }>;
}
