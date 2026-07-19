export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

export type PermissionMode = "ask" | "acceptEdits" | "yolo";
export type SandboxCapability = "advisory" | "partial" | "enforced";
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "off";

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
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  setupScript?: string;
  sandbox?: {
    enabled: boolean;
    readRoots: string[];
    writeRoots: string[];
    denyPaths: string[];
    network: "allow" | "deny";
  };
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
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  seq: number;
  createdAt: string;
  payload: unknown;
}

export interface ContextView {
  ledger: {
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
    cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
    entries: Array<{ messageId: string; state: "full" | "evicted" | "restored"; artifactId: string }>;
    policy?: { maxSessionTokens?: number; maxSessionCost?: { currency: "USD" | "CNY"; microUnits: string } };
    compacted?: { uptoIndex: number; mode: "toolcalls" | "overview" | "truncated"; summary: string; instructions: string[]; createdAt: string };
  };
  preferences: { language: string; currency: "USD" | "CNY"; currencyLabel: string };
}

export interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  source?: "builtin" | "api" | "manual";
  contextWindow: number;
  maxOutput: number;
  capabilities: {
    thinking: Array<"adaptive" | "enabled" | "disabled">;
    effort: Array<"low" | "medium" | "high" | "xhigh" | "max">;
    modalities: string[];
  };
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
  currency: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
  [key: string]: unknown;
}

export interface PricingDocument {
  version: 1;
  updatedAt: string;
  entries: PricingEntry[];
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
}

export type SettingFieldType = "text" | "secret" | "number" | "boolean" | "select";
export type SettingValue = string | number | boolean;

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
