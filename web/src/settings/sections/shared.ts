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
  general: "Language and currency",
  executor: "Executor",
  service: "Storage",
  network: "Listen address and port",
  proxy: "Outbound proxy",
  webSearch: "Web search",
  exchangeRate: "Exchange rate",
  updateCheck: "Update check",
};

/** 监听地址/端口所在分组：渲染在"远程访问"页签 */
export const NETWORK_SETTINGS_GROUP = "network";

/**
 * 服务端设置分组 → 设置页签归属。分组 id 由服务端保持稳定（见 server/src/settings-service.ts），
 * web 端决定每个分组渲染在哪个页签：模型选择 → 模型选择，模型目录与同步 → 模型目录，语言与货币 → 通用，
 * 汇率 → 模型定价，执行器/存储/更新检查 → 服务信息，监听与端口 → 远程访问，出站代理/联网搜索 → 联网服务。
 */
export const SETTING_GROUP_TAB: Record<string, SettingsTab> = {
  modelSelection: "modelSelection",
  models: "models",
  general: "general",
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
  fastModel: { label: "Fast model", description: "Used for context compaction and Content Lens, and as the fast sub-agent role; models come from the unified catalog of enabled providers" },
  fastModelThinking: { label: "Thinking" },
  fastModelEffort: { label: "Effort" },
  defaultModel: { label: "Session default model", description: "Default provider and model for new sessions; leave empty to fall back to the first catalog model of the first enabled provider" },
  roleModelPremium: { label: "Premium tier model", description: "Model for the premium sub-agent role: hard reasoning and deep review; falls back to the balanced tier when unset" },
  roleModelBalanced: { label: "Balanced tier model", description: "Model for the balanced sub-agent role: the default quality/cost trade-off; falls back to the session default when unset" },
  roleModelCheap: { label: "Cheap tier model", description: "Model for the cheap sub-agent role: bulk, low-stakes fan-out work; falls back to the balanced tier when unset" },
  defaultLanguage: { label: "Default model language" },
  agentMaxTurns: { label: "Max turns per message", description: "Maximum agent turns allowed per user message; the task ends with a failure once reached. Increase for long tasks (1-1000)" },
  subAgentMaxTurns: { label: "Max sub-agent turns", description: "Default turn limit for sub-agents (spawn_task / spawn_swarm / manual launch); spawn_task / spawn_swarm accept a maxTurns argument to override per call (1-1000)" },
  chatModeEnabled: { label: "Enable Chat mode", description: "Off by default; when enabled, the UI shows a Chat / Workbench mode toggle for the ChatGPT-style chat mode" },
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
  host: { label: "Listen address" },
  port: { label: "Listen port" },
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
/** 允许填 0 的数值设置（0 表示仅手动）：远程同步间隔、更新检查间隔 */
export const ZERO_ALLOWED_NUMBER_KEYS = new Set(["syncIntervalMinutes", "updateCheckIntervalHours"]);
