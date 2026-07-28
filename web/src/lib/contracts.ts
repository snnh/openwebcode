export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

export type PermissionMode = "ask" | "acceptEdits" | "yolo";
export type SandboxCapability = "advisory" | "partial" | "enforced";
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "off";
export type SnapshotMode = "auto" | "manual";
export type ShellBackend = "default" | "pwsh";

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
  /** spawn_task/spawn_swarm 工具结果携带的子代理转录 id 列表 */
  subagentTaskIds?: string[];
}

/** GET /api/sessions/:id/subagents/:taskId 响应：runSubAgent 落盘的子代理转录 */
export interface SubagentTranscript {
  id: string;
  prompt: string;
  agent?: string;
  startedAt: string;
  turns: number;
  toolsUsed: string[];
  conclusion: string;
  messages: ChatMessage[];
}

/** swarm 批量派生中的单项序号（WS 事件与实时状态共用） */
export interface SubagentSwarmRef {
  index: number;
  total: number;
}

/** WS 事件 subagent.started 的 payload */
export interface SubagentStartedEvent {
  toolCallId: string;
  taskId: string;
  prompt: string;
  agent?: string;
  swarm?: SubagentSwarmRef;
}

/** WS 事件 subagent.progress 的 payload（仅元数据：轮次与已用工具，不含文本） */
export interface SubagentProgressEvent {
  toolCallId: string;
  taskId: string;
  turns: number;
  toolsUsed: string[];
  swarm?: SubagentSwarmRef;
}

/** WS 事件 subagent.finished 的 payload */
export interface SubagentFinishedEvent {
  toolCallId: string;
  taskId: string;
  status: "done" | "failed";
  turns?: number;
  toolsUsed?: string[];
  error?: string;
  swarm?: SubagentSwarmRef;
}

/** 客户端按会话维护的子代理实时运行状态（tool.end 到达后由持久化 tool_result 接管渲染） */
export interface LiveSubagentRun {
  taskId: string;
  toolCallId: string;
  prompt: string;
  agent?: string;
  swarm?: SubagentSwarmRef;
  status: "running" | "done" | "failed";
  turns: number;
  toolsUsed: string[];
  error?: string;
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
  shellBackend?: ShellBackend;
  setupScript?: string;
  /** 选择性上下文：pin 的消息 id/文件路径（不被驱逐）。 */
  contextPins?: string[];
  /** 上下文排除路径 glob（不是安全边界）。 */
  contextExcludes?: string[];
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
  /** Total message count in messages.jsonl (may exceed messages.length when paginated) */
  messageCount?: number;
  /** Whether older messages exist beyond the returned page */
  hasMoreMessages?: boolean;
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
  kind: "confirm" | "single_select" | "multi_select" | "text";
  title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }>;
  status: "pending" | "answered" | "cancelled"; createdAt: string; answer?: unknown; answeredAt?: string;
}

export interface SessionTimeline { activeLeafId?: string; entries: Array<{ id: string; parentId?: string; runId?: string; turnId?: string; role: "user" | "assistant" | "tool"; createdAt: string }>; }
export interface QueueItem { id: string; sessionId: string; kind: "steer" | "follow_up"; content: string; status: "queued" | "consuming" | "applied" | "cancelled"; createdAt: string; updatedAt: string; }

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

export interface ContextSegmentBreakdown {
  system: number;
  compactionSummary: number;
  toolResults: number;
  messages: number;
  repoMap: number;
  other: number;
}

export interface ContextBuildStats {
  totalTokens: number;
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
  buildMs: number;
  incremental: boolean;
}

/** WS 事件 context.watermark 的 payload：每轮 agent 结束后上报的实时上下文窗口水位。 */
export interface ContextWatermark {
  estimatedTokens: number;
  contextWindow: number;
  maxOutput: number;
  workingBudget: number;
  utilization: number;
  warning?: "force_compact" | "compact_recommended";
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
  buildMs: number;
  incremental: boolean;
  pinWarning?: string;
}

/** 一组 token 用量计数。Anthropic 口径：inputTokens 为未缓存输入，总输入 = inputTokens + cacheRead。 */
export interface ContextTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/** WS 事件 context.usage 的 payload：每次 provider API 调用后的本轮 token 用量与成本。 */
export interface ContextUsage extends ContextTokenUsage {
  cost?: {
    priced: boolean;
    source?: { currency: string; amount: number };
    usd?: number;
    cny?: number;
  };
  sessionCost?: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
}

export interface ContextView {
  stats?: ContextBuildStats;
  selection?: { pins: string[]; excludes: string[] };
  ledger: {
    round?: number;
    usage: ContextTokenUsage;
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
    /** 最近记录的 prompt cache 消息级断点（消息 id）；诊断用。 */
    cacheBreakpoints?: string[];
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

/** WS 事件 diagnostics.updated 的 payload：携带 runId 与汇总，客户端收到后重新拉取 latest */
export interface DiagnosticsUpdatedEvent {
  sessionId: string;
  runId?: string;
  summary?: { failed?: number };
}

// ---- SCM（Phase 4）：GET /api/sessions/:id/git/* 的契约（与 server/src/scm/types.ts 对齐） ----

/** 单条变更条目（porcelain v1 解析结果）：path + XY 状态码（如 "M "、" M"、"A "、"??"），rename 带 originalPath */
export interface ScmStatusEntry {
  path: string;
  code: string;
  originalPath?: string;
}

/** GET /api/sessions/:id/git/status 的响应；非 git 仓库时 isRepo=false 且分支等字段缺省 */
export interface ScmStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: ScmStatusEntry[];
  unstaged: ScmStatusEntry[];
  untracked: ScmStatusEntry[];
  /** 分组截断后仍保留真实总数 */
  totals: { staged: number; unstaged: number; untracked: number };
  /** 任一分组因有界输出被截断 */
  truncated: boolean;
}

/** GET /api/sessions/:id/git/diff 的响应；truncated 时只有 stat，完整 diff 落 artifact（artifactId 可经 read_artifact 续读） */
export interface ScmDiff {
  isRepo: boolean;
  /** git diff --stat 输出（可能为空字符串表示无变更） */
  stat: string;
  /** 未超阈值时的完整 unified diff 文本 */
  diff?: string;
  artifactId?: string;
  /** 完整 diff 字节数 */
  totalBytes: number;
  truncated: boolean;
}

/** worktree 条目：name 为注册名（也是 DELETE 路由参数），exists 为 list 时的磁盘探测结果 */
export interface ScmWorktree {
  name: string;
  path: string;
  branch: string;
  createdAt: string;
  exists: boolean;
}

/** WS 事件 scm.updated 的 payload（reason 如 worktree.create，附带 detail 字段）；收到后刷新该会话的 SCM 状态 */
export interface ScmUpdatedEvent {
  sessionId: string;
  reason: string;
  [key: string]: unknown;
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

export type ModelInterfaceType = "anthropic-messages" | "openai-chat-completions";
export type WebCapability = "search" | "fetch";
export type WebProviderType = "jina" | "brave" | "tavily" | "custom";

export interface ModelProviderProfileView {
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  baseURL?: string;
  promptCaching?: boolean;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export interface WebProviderProfileView {
  id: string;
  provider: WebProviderType;
  capabilities: WebCapability[];
  searchBaseURL?: string;
  fetchBaseURL?: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export interface ProviderProfilesView {
  modelProviders: ModelProviderProfileView[];
  webProviders: WebProviderProfileView[];
  activeWeb: { search?: string; fetch?: string };
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

/** GET /api/workspaces/files 响应（0.4.0 Phase 2 §5.2）：索引文件清单搜索 */
export interface WorkspaceFileHit {
  path: string;
  modifiedMs: number;
}
export interface WorkspaceFilesResponse {
  files: WorkspaceFileHit[];
  indexStatus: WorkspaceIndexState;
}

/** GET /api/workspaces/symbols 响应：索引符号模糊搜索 */
export interface WorkspaceSymbolHit {
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

/** GET /api/workspaces/index/status 响应（0.4.0 Phase 2 §7.2） */
export type WorkspaceIndexState = "fresh" | "stale" | "building" | "missing";
export interface WorkspaceIndexStatus {
  status: WorkspaceIndexState;
  workspace: string;
  files: number;
  symbols: number;
  lastScanAt?: number;
  scanTruncated?: boolean;
  staleReason?: "watch" | "mtime" | "corrupt" | "cancelled" | "error";
  watch: "active" | "fallback" | "none";
  jobId?: string;
  message?: string;
}

// ---- 性能采样（0.5.0 Phase 2d）：GET /api/sessions/:id/perf 的契约 ----

/** 单次 run 的性能采样记录（脱敏：不含消息内容、文件路径、模型名） */
export interface RunPerfRecord {
  runId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  turnCount: number;
  stages: {
    contextBuildMs: number;
    providerCallMs: number;
    toolExecMs: number;
    totalMs: number;
  };
}

/** 0.5.0 Phase 2：per-provider 并发与队列深度诊断（GET /api/providers/stats） */
export interface ProviderConcurrencyStats {
  active: number;
  queued: number;
  maxConcurrent: number;
}

// ---- 评测 harness（0.5.0 Phase 3a）：GET/POST /api/eval/* 的契约 ----

/** 声明式断言：回放结束后对工作区与消息做静态检查 */
export interface EvalAssertion {
  toolUsed?: string[];
  fileExists?: string[];
  fileContains?: Record<string, string>;
  messageContains?: string;
  maxTurns?: number;
}

/** 任务信息（不含内部 mock 脚本） */
export interface EvalTaskInfo {
  id: string;
  name: string;
  description: string;
  workspace: string;
  instruction: string;
  assertions: EvalAssertion;
}

/** 单条断言检查结果 */
export interface EvalAssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** 单个任务的回放结果 */
export interface EvalTaskResult {
  taskId: string;
  taskName: string;
  status: "pass" | "fail" | "error";
  assertions: EvalAssertionResult[];
  durationMs: number;
  turns: number;
  toolsUsed: string[];
  toolCalls: string[];
  usage: EvalTokenUsage;
  error?: string;
}

export interface EvalTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** 一次评测运行的完整报告 */
export interface EvalRunReport {
  schemaVersion: 1;
  taskSetId: "owc-smoke-v1";
  provider: "eval-mock";
  model: "eval-model";
  runId: string;
  startedAt: string;
  finishedAt: string;
  taskResults: EvalTaskResult[];
  summary: { total: number; passed: number; failed: number; errored: number; durationMs: number; usage: EvalTokenUsage };
}

/** 历史报告摘要 */
export interface EvalRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: EvalRunReport["summary"];
  taskCount: number;
}

export interface EvalTaskComparison {
  taskId: string;
  taskName: string;
  baselineStatus?: EvalTaskResult["status"];
  candidateStatus?: EvalTaskResult["status"];
  regressed: boolean;
  improved: boolean;
  durationMsDelta: number;
  totalTokensDelta: number;
  toolCallsChanged: boolean;
  baselineToolCalls: string[];
  candidateToolCalls: string[];
}

export interface EvalRunComparison {
  schemaVersion: 1;
  comparisonId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  baseline: EvalRunReport;
  candidate: EvalRunReport;
  summary: {
    passedDelta: number;
    failedDelta: number;
    erroredDelta: number;
    durationMsDelta: number;
    totalTokensDelta: number;
    regressions: number;
    improvements: number;
  };
  tasks: EvalTaskComparison[];
}

export interface EvalComparisonSummary {
  comparisonId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  summary: EvalRunComparison["summary"];
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

export interface UpdateCheckSnapshot {
  latestVersion: string;
  isNewer: boolean;
  htmlUrl: string;
  publishedAt: string;
  checkedAt: string;
}

export interface UpdateCheckResponse {
  snapshot: UpdateCheckSnapshot | null;
}

export type UpdateApplyStatus = "idle" | "downloading" | "verifying" | "applying" | "restarting" | "done" | "error";

export interface UpdateApplyState {
  status: UpdateApplyStatus;
  version: string;
  /** 0..1，未知为 null */
  progress: number | null;
  message: string;
  error?: string;
  startedAt: string;
}

export interface PromptOverrideView {
  builtinBase: string;
  promptVersion: string;
  baseOverride: string | null;
  customAppend: string | null;
}
