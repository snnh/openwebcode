import type { SettingsTab, SettingValue } from "../../lib/contracts";

/** 比较两个设置值（数组按元素逐项比较）。 */
export function sameValue(left: SettingValue | null | undefined, right: SettingValue | null | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

/** 将设置值格式化为简短的展示文本（用于"安装默认值现为 …"提示）。 */
export function formatSettingValue(value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "[]";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export const SETTINGS_GROUP_EN: Record<string, string> = {
  modelSelection: "Model Selection",
  models: "Model Catalog & Sync",
  general: "General",
  defaults: "Session Defaults",
  context: "Context & Runtime",
  executor: "Executor",
  service: "Storage",
  network: "Listen address and port",
  proxy: "Outbound proxy",
  webSearch: "Network",
  exchangeRate: "Exchange rate",
  updateCheck: "Update check",
};

/** 监听地址/端口所在分组：渲染在"远程访问"页签 */
export const NETWORK_SETTINGS_GROUP = "network";

/**
 * 服务端设置分组 → 设置页签归属。分组 id 由服务端给出（见 server/src/settings-service.ts），
 * web 端决定每个分组渲染在哪个页签：模型选择 → 模型选择，模型目录与同步 → 模型目录，
 * 通用（语言/货币/模式开关）→ 通用，会话默认 → 会话默认，上下文与运行 → 上下文，
 * 汇率 → 模型定价，执行器/存储/更新检查 → 服务信息，监听与端口 → 远程访问，
 * 出站代理/联网（搜索模式、离线模式）→ 联网服务。
 */
export const SETTING_GROUP_TAB: Record<string, SettingsTab> = {
  modelSelection: "modelSelection",
  models: "models",
  general: "general",
  defaults: "defaults",
  context: "context",
  executor: "info",
  service: "info",
  network: "remote",
  proxy: "web",
  webSearch: "web",
  exchangeRate: "pricing",
  updateCheck: "info",
};

/** 「模型选择」页签承载的设置分组（会话默认 + 四档角色 + 快速模型） */
export const MODEL_SELECTION_GROUPS = new Set(["modelSelection"]);
/** 「模型目录」页签承载的设置分组（模型目录与同步） */
export const MODELS_TAB_GROUPS = new Set(["models"]);
/** 「服务信息」页签承载的设置分组（执行器 + 存储 + 更新检查，系统级参数） */
export const INFO_TAB_GROUPS = new Set(["executor", "service", "updateCheck"]);

export const SETTINGS_FIELD_EN: Record<string, { label: string; description?: string }> = {
  catalogSyncUrl: { label: "Remote model catalog URL", description: "Leave empty to disable remote model catalog sync" },
  pricingSyncUrl: { label: "Remote pricing catalog URL", description: "Leave empty to disable remote pricing sync" },
  syncIntervalMinutes: { label: "Remote sync interval (minutes)", description: "0 means manual sync only; a value above 0 enables periodic sync (maximum 35,791 minutes)" },
  providerStreamIdleMs: { label: "Stream idle timeout (ms)", description: "SSE stream idle timeout (half-open connection fallback): 0 disables the idle timeout; blank uses the provider's built-in default. Applies at the next provider registration (restart or provider-profile change)" },
  fastModel: { label: "Fast model", description: "Used for context compaction and Content Lens, and as the fast sub-agent role; models come from the unified catalog of enabled providers" },
  fastModelThinking: { label: "Thinking" },
  fastModelEffort: { label: "Effort" },
  fastModelTimeoutMs: { label: "Fast model timeout (ms)", description: "Per-attempt timeout for fast model requests (1000-900000, default 60000); raise it for slow thinking models — a timeout retries as a failure" },
  defaultModel: { label: "Session default model", description: "Default provider and model for new sessions; leave empty to fall back to the first catalog model of the first enabled provider" },
  roleModelPremium: { label: "Premium tier model", description: "Model for the premium sub-agent role: hard reasoning and deep review; falls back to the balanced tier when unset" },
  roleModelBalanced: { label: "Balanced tier model", description: "Model for the balanced sub-agent role: the default quality/cost trade-off; sub-agents default to this tier when no role is given, falling back to the session default when unset" },
  roleModelCheap: { label: "Cheap tier model", description: "Model for the cheap sub-agent role: bulk, low-stakes fan-out work; falls back to the balanced tier when unset" },
  defaultLanguage: { label: "Default model language" },
  agentMaxTurns: { label: "Max turns per message", description: "Maximum agent turns allowed per user message; the task ends with a failure once reached. Increase for long tasks (1-1000)" },
  subAgentMaxTurns: { label: "Max sub-agent turns", description: "Default turn limit for sub-agents (subagent / spawn_swarm / manual launch); subagent / spawn_swarm accept a maxTurns argument to override per call (1-1000)" },
  subAgentConcurrency: { label: "Sub-agent parallelism", description: "Maximum number of subagent calls that run at the same time within one message (1-16, default 2): this limits concurrency only, never the total number of sub-agents — calls beyond the limit queue and run in order. 1 = sequential; raise it (e.g. 4) so a multi-subagent fan-out runs in parallel. spawn_swarm member concurrency is controlled separately below" },
  spawnSwarmConcurrency: { label: "spawn_swarm member concurrency", description: "How many swarm members run at once per spawn_swarm call (2-16, default 4); the total item cap stays 16. spawn_swarm is a parallel orchestration, so fewer than 2 members cannot form a swarm" },
  chatModeEnabled: { label: "Enable Chat mode", description: "Off by default; when enabled, the UI shows a Chat / Workbench mode toggle for the ChatGPT-style chat mode" },
  userAgent: { label: "Outbound User-Agent", description: "Custom User-Agent for all outbound HTTP requests (web search/fetch, model APIs, MCP, etc.); blank = the official default owc/openwebcode{version}. Single line, up to 200 characters. An active env-sim persona still takes precedence" },
  compactionThresholdPercent: { label: "Auto-compaction threshold (%)", description: "The context is compacted automatically when usage reaches this percentage (50-100); the recommendation threshold is 15 points lower; 100 disables threshold-based forced compaction (a one-shot safety compaction still runs on provider context overflow). Core safety net, independent of the context-saver extension" },
  defaultCurrency: { label: "Default currency" },
  defaultEffort: { label: "Default thinking effort", description: "Thinking effort applied to new sessions; none means follow the model default; silently skipped when the model does not support the selected level" },
  defaultSnapshotMode: { label: "Default snapshot mode", description: "Checkpoint creation for new sessions: auto = before each user message; manual = only on demand" },
  snapshotBackend: { label: "Snapshot backend", description: "Preferred snapshot backend for new sessions; auto = probe chain (btrfs/zfs/overlayfs → git-shadow); falls back to auto with a warning when the selected backend is unavailable for the workspace" },
  offlineMode: { label: "Offline mode", description: "Disables the server's own startup/periodic outbound requests: update checks, background remote model/pricing catalog sync, and online exchange-rate refresh; model APIs, web search/fetch, MCP, and extension networking are unaffected" },
  corePath: { label: "Executor path" },
  coreRequestTimeoutMs: { label: "Executor request timeout (ms)" },
  sandboxAllowPaths: { label: "Additional allowed directories", description: "One directory per line, up to 16; merged with the session working directory at execution time" },
  jobObjectMemoryMB: { label: "Job memory limit (MB)", description: "Process-tree commit-memory limit; defaults to 4096; only applied on Windows (Job Object)" },
  jobObjectMaxProcesses: { label: "Job process limit", description: "Process-tree active-process limit; defaults to 64; only applied on Windows (Job Object)" },
  gcMaxBytes: { label: "Storage limit (bytes)", description: "Global LRU limit for session artifacts; oldest data is removed first" },
  usageLogCleanupMode: { label: "Usage log cleanup mode", description: "off = disabled; deleted-after-days = remove events of deleted sessions older than the retention days (live sessions kept); all-after-days = remove all events older than the retention days; deleted-immediate-live-timeout = remove deleted-session events immediately and live-session events after the retention days; deleted-immediate-only = remove deleted-session events immediately, keep live sessions" },
  usageLogRetentionDays: { label: "Usage log retention (days)", description: "Retention days used by the cleanup modes (1-3650); applies to the after-days / live-timeout branches" },
  host: { label: "Listen address" },
  port: { label: "Listen port" },
  allowedOrigins: { label: "Allowed origins", description: "Comma-separated browser origin whitelist (e.g. https://a.example.com,https://b.example.com; up to 16; plain http(s) origins without a path). Blank = same-origin browsers are auto-allowed and the access token stays the only credential" },
  dataDir: { label: "Data directory" },
  exchangeRateUrl: { label: "Exchange-rate API URL" },
  exchangeRateTimeoutMs: { label: "Exchange-rate request timeout (ms)" },
  fixedUsdCnyRate: { label: "Fixed USD/CNY rate", description: "Skips online exchange-rate lookup when set" },
  updateCheckEnabled: { label: "Enable update check", description: "Off by default; when enabled, periodically checks GitHub Releases for the latest version" },
  updateCheckUrl: { label: "Update check URL", description: "GitHub Releases API endpoint" },
  updateCheckIntervalHours: { label: "Check interval (hours)", description: "0 means manual checks only; maximum 720 hours" },
  proxyMode: { label: "Proxy mode", description: "off = direct connections only; env = follow HTTPS_PROXY/HTTP_PROXY/NO_PROXY; custom = use the proxy addresses below" },
  proxyHttp: { label: "HTTP proxy", description: "e.g. http://127.0.0.1:7890, credentials allowed; only used in custom mode; also the fallback when HTTPS proxy is blank" },
  proxyHttps: { label: "HTTPS proxy", description: "Proxy used for https targets; falls back to the HTTP proxy when blank" },
  proxyNoProxy: { label: "Proxy bypass list", description: "Comma-separated hostnames or domain suffixes (e.g. internal.example.com) that skip the proxy; loopback addresses always bypass" },
  webSearchMode: { label: "Web search mode", description: "local = the local web_search tool runs through the configured search provider; model-api = the model provider searches server-side (OpenAI Responses API only; the local web_search tool is then not injected); web_fetch works in both modes" },
};

export const MAX_SYNC_INTERVAL_MINUTES = 35_791;
export const MAX_UPDATE_CHECK_INTERVAL_HOURS = 720;
/** 允许填 0 的数值设置（0 表示仅手动/关闭）：远程同步间隔、更新检查间隔、流空闲超时 */
export const ZERO_ALLOWED_NUMBER_KEYS = new Set(["syncIntervalMinutes", "updateCheckIntervalHours", "providerStreamIdleMs"]);
