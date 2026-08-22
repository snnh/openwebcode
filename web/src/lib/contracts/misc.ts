export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

/** cron 定时任务（提交⑫）：GET/POST /api/sessions/:id/cron 的返回形状。 */
export interface CronJobInfo {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: string;
  /** ISO 时间；stale（待最后一次触发）时为 null。 */
  nextFireAt: string | null;
  stale: boolean;
}

export type PermissionMode = "ask" | "acceptEdits" | "review" | "yolo";

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

/** agent.error 事件中 provider 错误的分类（与 server providers/provider-error.ts 对齐）；非 provider 失败省略 kind */
export type AgentErrorKind =
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "network"
  | "stream_interrupted"
  | "invalid_request"
  | "unknown";

/** WS 事件 agent.error 的 payload */
export interface AgentErrorPayload {
  message: string;
  kind?: AgentErrorKind;
  retryable?: boolean;
}

/** 会话级备选模型（fallback 链）条目。 */
export interface FallbackModelEntry {
  provider: string;
  model: string;
}

/** WS 事件 agent.model_fallback 的 payload：主模型可恢复错误重试耗尽后切换到备选模型。 */
export interface ModelFallbackPayload {
  from: FallbackModelEntry;
  to: FallbackModelEntry;
  kind?: AgentErrorKind;
  message: string;
}

/** plan_approval 交互的回答体：approve 按计划原文执行；edit 带用户改后文本；reject 附意见保持 plan 模式。 */
export type PlanApprovalAnswer = { decision: "approve" } | { decision: "edit"; plan: string } | { decision: "reject"; feedback: string };

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
}

/** 单条诊断失败项（DiagnosticSet.failures 元素）；file/line 缺失表示无法定位到文件 */
export interface DiagnosticFailure {
  name: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  excerpt?: string;
}

/** 一次诊断运行的汇总（test_runner 等工具产出） */
export interface DiagnosticSet {
  tool: string;
  summary: { passed: number; failed: number; skipped: number; durationMs: number };
  failures: DiagnosticFailure[];
}

export type SettingFieldType = "text" | "secret" | "number" | "boolean" | "select" | "pathList";
export type SettingValue = string | number | boolean | string[];

export interface SettingsField {
  key: string;
  label: string;
  type: SettingFieldType;
  options?: Array<{ value: string; label: string }>;
  value: SettingValue | null;
  hasValue: boolean;
  masked?: string;
  source: "default" | "env" | "file";
  editable: boolean;
  restartRequired: boolean;
  nullable: boolean;
  installDefault?: SettingValue | null;
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

/** 设置对话框页签（定义在 contracts 供 lib 层引用；SettingsDialog 再导出） */
export type SettingsTab = "appearance" | "general" | "defaults" | "shortcuts" | "remote" | "models" | "modelSelection" | "context" | "web" | "skills" | "extensions" | "pricing" | "prompt" | "info" | "notifications";

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
  /** 缓存节省估算（定价目录价差反事实；按可得币种给值）；无缓存读取时默认。 */
  cacheSavings?: { usdMicroUnits?: string; cnyMicroUnits?: string };
  /** 有缓存读取但定价缺失/无法换算：节省估算不完整（UI 标 *）。 */
  cacheSavingsIncomplete?: boolean;
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

/** GET /api/sessions/:id/complete-path 响应：core.globFiles（模式 *q*）截断至 20 条 */
export interface CompletePathResponse {
  matches: Array<{ path: string }>;
}

/** GET /api/workspaces/files 响应（0.4.0 Phase 2 §5.2）：索引文件清单搜索 */
interface WorkspaceFileHit {
  path: string;
  modifiedMs: number;
}
export interface WorkspaceFilesResponse {
  files: WorkspaceFileHit[];
  indexStatus: WorkspaceIndexState;
}

/** GET /api/workspaces/symbols 响应：索引符号模糊搜索 */
interface WorkspaceSymbolHit {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
}
export interface WorkspaceSymbolsResponse {
  symbols: WorkspaceSymbolHit[];
  indexStatus: WorkspaceIndexState;
}

/** 索引新鲜度标记（0.4.0 Phase 2）：files/symbols 响应随带 */
type WorkspaceIndexState = "fresh" | "stale" | "building" | "missing";

/** 0.5.0 Phase 2：per-provider 并发与队列深度诊断（GET /api/providers/stats） */
export interface ProviderConcurrencyStats {
  active: number;
  queued: number;
  maxConcurrent: number;
}

export interface VersionInfo {
  server: string;
  core: string;
  protocolVersion?: string;
  githubRepo: string;
  latestRelease?: {
    version: string;
    isNewer: boolean;
    htmlUrl: string;
    publishedAt: string;
    checkedAt: string;
  };
}

export interface PromptOverrideView {
  builtinBase: string;
  /** 服务端始终返回；声明为可选以兼容旧的测试桩 */
  builtinInitPrompt?: string;
  builtinCompactOverviewPrompt?: string;
  builtinCompactToolcallsPrompt?: string;
  promptVersion: string;
  /** 服务端始终返回；声明为可选以兼容旧的测试桩 */
  identityOverride?: string | null;
  baseOverride: string | null;
  customAppend: string | null;
  /** 服务端始终返回；声明为可选以兼容旧的测试桩 */
  subAgentAppend?: string | null;
  /** 服务端始终返回；声明为可选以兼容旧的测试桩 */
  initOverride?: string | null;
  compactOverviewOverride?: string | null;
  compactToolcallsOverride?: string | null;
}
