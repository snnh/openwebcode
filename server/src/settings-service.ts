import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "./atomic-file.js";
import { ensureDirWithMode } from "./fs-utils.js";
import type { AgentRunner } from "./agent/agent-runner.js";
import { loadConfig, defaultCorePath, SNAPSHOT_BACKENDS, type ServerConfig, type SnapshotBackendName } from "./config.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "./remote-sync-scheduler.js";
import type { CoreClientLike } from "./core-client.js";
import type { EventBus } from "./events/event-bus.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { StorageGC } from "./storage-gc.js";
import type { FastModelClient } from "./fast-model.js";
import type { ProviderProfilesService } from "./provider-profiles.js";
import type { ModelRegistry } from "./context/model-registry.js";
import type { UpdateChecker } from "./update-checker.js";
import type { NodeEnv, PythonEnv } from "./sessions/types.js";
import type { EffortLevel } from "./context/model-profile.js";
import { applyProxyConfig, sanitizeProxyUrl, type ProxyApplyResult, type ProxyConfig, type ProxyMode } from "./proxy.js";
import installDefaultsDocument from "./config/defaults.json" with { type: "json" };

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export type SettingFieldType = "text" | "secret" | "number" | "boolean" | "select" | "pathList";
export type SettingValue = string | number | boolean | string[];
export type SettingSource = "default" | "env" | "file";

export interface SettingOptionView {
  value: string;
  label: string;
}

export interface SettingsFieldView {
  key: string;
  label: string;
  type: SettingFieldType;
  options?: SettingOptionView[];
  value: SettingValue | null;
  hasValue: boolean;
  masked?: string;
  source: SettingSource;
  editable: boolean;
  restartRequired: boolean;
  nullable: boolean;
  /** 安装目录默认值；当 source=file 且与 value 不同时，UI 可提示"采纳新默认"。 */
  installDefault?: SettingValue | null;
  description?: string;
}

export interface SettingsGroupView {
  id: string;
  label: string;
  fields: SettingsFieldView[];
}

export interface SettingsView {
  groups: SettingsGroupView[];
}

interface FieldSpec {
  key: string;
  group: string;
  label: string;
  type: SettingFieldType;
  env: string;
  defaultValue: SettingValue | null;
  /** 运行时平台相关默认（如 corePath 的 POSIX 布局）；缺省回退安装默认/代码兜底。 */
  runtimeDefault?: () => SettingValue;
  restartRequired: boolean;
  options?: string[];
  fromEnv?: (raw: string) => SettingValue | undefined;
  validate?: (value: SettingValue) => void;
  /** secret 字段的自定义脱敏（如代理 URL 需隐去凭据但保留 host）；缺省用 maskSecret */
  mask?: (value: string) => string;
  description?: string;
}

interface RuntimeDependencies {
  providers: ProviderRegistry;
  core: CoreClientLike;
  agent: AgentRunner;
  events: EventBus;
  gc?: StorageGC;
  fastModel?: FastModelClient;
  profiles?: ProviderProfilesService;
  models?: ModelRegistry;
  updateChecker?: UpdateChecker;
  /** 出站代理热应用；缺省 proxy.ts 的真实全局 dispatcher 安装，测试注入 fake */
  applyProxy?: (config: ProxyConfig) => ProxyApplyResult;
  /** filtered 网络档 sidecar 编排；sandboxProxyDenyList 变更时重写活跃会话的 deny 文件 */
  sandboxProxy?: { refreshDenyFiles(): Promise<void> };
}

const GROUPS = [
  { id: "models", label: "模型接入" },
  { id: "modelSelection", label: "模型选择" },
  { id: "general", label: "语言与货币" },
  { id: "executor", label: "执行器" },
  { id: "service", label: "存储" },
  // 监听地址/端口单独分组：Web 端在"远程访问"页签渲染；分组 id 保持稳定，渲染位置由 Web 端决定
  { id: "network", label: "监听与端口" },
  // 出站代理：Web 端在"联网服务"页签由专门组件渲染（secret 字段按 mask 脱敏）
  { id: "proxy", label: "出站代理" },
  // 联网搜索模式：Web 端在"联网服务"页签渲染
  { id: "webSearch", label: "联网搜索" },
  { id: "exchangeRate", label: "汇率" },
  { id: "updateCheck", label: "更新检查" },
];

const LANGUAGE_OPTIONS = ["zh-CN", "en-US", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "ru-RU"];
const PYTHON_ENV_OPTIONS = ["global", "uv-workspace", "uv-config"];
const NODE_ENV_OPTIONS = ["global", "project", "fnm", "nvm"];
const THINKING_OPTIONS = ["disabled", "adaptive", "enabled"];
const EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
const PROXY_MODE_OPTIONS = ["off", "env", "custom"];
const WEB_SEARCH_MODE_OPTIONS = ["local", "model-api"];

export function encodeFastModelSelection(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

export function decodeFastModelSelection(value: unknown): [provider: string, model: string] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== "string" || parsed[0].trim() === "" ||
        typeof parsed[1] !== "string" || parsed[1].trim() === "") return undefined;
    return [parsed[0], parsed[1]];
  } catch { return undefined; }
}

/** 编码为 [provider, model] JSON 串的模型选择键：共享 optionsFor 动态选项与 select 校验逻辑。 */
const MODEL_SELECTION_KEYS = new Set(["fastModel", "defaultModel", "roleModelPremium", "roleModelBalanced", "roleModelCheap"]);

function requireHttpUrl(value: SettingValue): void {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new SettingsValidationError(`${String(value)} 不是合法的 URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SettingsValidationError("URL 仅支持 http/https");
  }
}

function requirePositiveDecimal(value: SettingValue): void {
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) {
    throw new SettingsValidationError("必须是大于 0 的十进制数");
  }
}

function requireNonEmpty(value: SettingValue): void {
  if (String(value).trim() === "") throw new SettingsValidationError("不能为空");
}

function requirePort(value: SettingValue): void {
  if (typeof value !== "number" || value < 1 || value > 65_535) {
    throw new SettingsValidationError("端口必须是 1-65535 的整数");
  }
}

function requireSyncIntervalMinutes(value: SettingValue): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SYNC_INTERVAL_MINUTES) {
    throw new SettingsValidationError(`必须是 0–${MAX_SYNC_INTERVAL_MINUTES} 的整数`);
  }
}

function requireUpdateCheckIntervalHours(value: SettingValue): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 24 * 30) {
    throw new SettingsValidationError("必须是 0–720 的整数小时");
  }
}

function requireNoProxyList(value: SettingValue): void {
  const entries = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 64 ||
      entries.some((entry) => entry !== "*" && !/^(\*\.)?\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*(:\d+)?$/i.test(entry))) {
    throw new SettingsValidationError("例外列表需为逗号分隔的主机名或域名后缀（最多 64 项）");
  }
}

function requireJobMemoryMB(value: SettingValue): void {
  if (typeof value !== "number" || value < 1 || value > 1_048_576) {
    throw new SettingsValidationError("Job 内存上限需为 1–1048576 MB (1 TB)");
  }
}

function requireJobMaxProcesses(value: SettingValue): void {
  if (typeof value !== "number" || value < 1 || value > 4096) {
    throw new SettingsValidationError("Job 进程数上限需为 1–4096");
  }
}

function requireAgentMaxTurns(value: SettingValue): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new SettingsValidationError("单条消息最大轮次需为 1–1000 的整数");
  }
}

function requirePathList(value: SettingValue): void {
  if (!Array.isArray(value) || value.length > 16 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new SettingsValidationError("允许目录必须是最多 16 项的非空路径列表");
  }
}

function requireDomainList(value: SettingValue): void {
  if (!Array.isArray(value) || value.length > 64 ||
      value.some((entry) => typeof entry !== "string" || !/^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i.test(entry.trim()))) {
    throw new SettingsValidationError("拦截域名必须是最多 64 项的域名列表（如 example.com）");
  }
}

function envNumber(raw: string): SettingValue | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function envSyncIntervalMinutes(raw: string): SettingValue | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_SYNC_INTERVAL_MINUTES ? parsed : undefined;
}

function envPathList(raw: string): SettingValue | undefined {
  const values = raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return values.length > 0 && values.length <= 16 ? values : undefined;
}

function envDomainList(raw: string): SettingValue | undefined {
  const values = raw.split(/[,\n]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return values.length > 0 && values.length <= 64 ? values : undefined;
}

function envCurrency(raw: string): SettingValue | undefined {
  const normalized = raw.toUpperCase();
  if (normalized === "RMB") return "CNY";
  if (normalized === "USD" || normalized === "CNY") return normalized;
  return undefined;
}

function envBoolean(raw: string): SettingValue | undefined {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

function envUpdateCheckIntervalHours(raw: string): SettingValue | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 24 * 30 ? parsed : undefined;
}

function envProxyMode(raw: string): SettingValue | undefined {
  return raw === "off" || raw === "env" || raw === "custom" ? raw : undefined;
}

const FIELDS: FieldSpec[] = [
  // 模型目录同步；模型服务商连接由 provider-profiles.json 独立管理。
  { key: "catalogSyncUrl", group: "models", label: "远程模型目录 URL", type: "text", env: "OWC_MODELS_CATALOG_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型目录" },
  { key: "pricingSyncUrl", group: "models", label: "远程定价目录 URL", type: "text", env: "OWC_MODELS_PRICING_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型定价" },
  { key: "syncIntervalMinutes", group: "models", label: "远程同步间隔（分钟）", type: "number", env: "OWC_MODELS_SYNC_INTERVAL_MINUTES", defaultValue: 0, restartRequired: false, fromEnv: envSyncIntervalMinutes, validate: requireSyncIntervalMinutes, description: `0 表示仅手动同步；大于 0 时按此间隔自动同步，最大 ${MAX_SYNC_INTERVAL_MINUTES} 分钟` },
  // 模型选择（modelSelection 组，顺序：会话默认 → 极致 → 平衡 → 快速 → 廉价）：
  // 值统一为 [provider, model] 编码串，全部热生效；快速档直接复用既有 fastModel 键。
  { key: "defaultModel", group: "modelSelection", label: "会话默认模型", type: "select", env: "OWC_DEFAULT_MODEL", defaultValue: null, restartRequired: false, description: "新建会话的默认服务商与模型；留空回落第一个已启用服务商的首个目录模型；模型来自已启用服务商的统一模型目录" },
  { key: "roleModelPremium", group: "modelSelection", label: "极致档模型", type: "select", env: "OWC_ROLE_MODEL_PREMIUM", defaultValue: null, restartRequired: false, description: "子代理 premium（极致）角色使用的模型：高难度推理/深度评审；未配置时回落平衡档" },
  { key: "roleModelBalanced", group: "modelSelection", label: "平衡档模型", type: "select", env: "OWC_ROLE_MODEL_BALANCED", defaultValue: null, restartRequired: false, description: "子代理 balanced（平衡）角色使用的模型：质量与成本的默认折中；未配置时回落会话默认" },
  // 内部低延迟任务复用已启用模型服务商，不维护第二套端点或密钥。
  { key: "fastModel", group: "modelSelection", label: "快速模型", type: "select", env: "OWC_FAST_MODEL", defaultValue: null, restartRequired: false, description: "用于上下文压缩和内容透镜，同时作为子代理 fast（快速）角色；模型来自已启用服务商的统一模型目录" },
  { key: "fastModelThinking", group: "modelSelection", label: "思考", type: "select", env: "OWC_FAST_MODEL_THINKING", defaultValue: "disabled", restartRequired: false, options: THINKING_OPTIONS },
  { key: "fastModelEffort", group: "modelSelection", label: "力度", type: "select", env: "OWC_FAST_MODEL_EFFORT", defaultValue: "none", restartRequired: false, options: EFFORT_OPTIONS },
  { key: "roleModelCheap", group: "modelSelection", label: "廉价档模型", type: "select", env: "OWC_ROLE_MODEL_CHEAP", defaultValue: null, restartRequired: false, description: "子代理 cheap（廉价）角色使用的模型：批量、低风险的分发任务；未配置时回落平衡档" },
  // 通用（热生效）
  { key: "defaultLanguage", group: "general", label: "默认语言", type: "select", env: "OWC_DEFAULT_LANGUAGE", defaultValue: "zh-CN", restartRequired: false, options: LANGUAGE_OPTIONS },
  { key: "defaultCurrency", group: "general", label: "默认货币", type: "select", env: "OWC_DEFAULT_CURRENCY", defaultValue: "CNY", restartRequired: false, options: ["USD", "CNY"], fromEnv: envCurrency },
  { key: "defaultEffort", group: "general", label: "默认思考力度", type: "select", env: "OWC_DEFAULT_EFFORT", defaultValue: "none", restartRequired: false, options: EFFORT_OPTIONS, description: "新建会话的思考力度；none 表示不设置（跟随模型默认），模型声明不支持所选力度时静默跳过" },
  { key: "defaultSnapshotMode", group: "general", label: "默认快照方式", type: "select", env: "OWC_DEFAULT_SNAPSHOT_MODE", defaultValue: "auto", restartRequired: false, options: ["auto", "manual"], description: "新建会话的检查点创建方式：auto = 每轮用户消息前自动创建；manual = 仅手动创建" },
  { key: "snapshotBackend", group: "general", label: "快照后端", type: "select", env: "OWC_SNAPSHOT_BACKEND", defaultValue: "auto", restartRequired: false, options: ["auto", ...SNAPSHOT_BACKENDS], description: "新建会话的快照后端偏好；auto = 按探测链自动选择（btrfs/zfs/overlayfs → git-shadow）；指定后端在当前工作区不可用时回落自动并告警" },
  { key: "agentMaxTurns", group: "general", label: "单条消息最大轮次", type: "number", env: "OWC_AGENT_MAX_TURNS", defaultValue: 50, restartRequired: false, fromEnv: envNumber, validate: requireAgentMaxTurns, description: "每条用户消息允许的最大 agent 轮次，达到后当前任务以失败收尾；长任务可调大（1–1000）" },
  // Chat 模式开关（热生效）：web 侧据此显示 chat/workbench 切换，默认关闭
  { key: "chatModeEnabled", group: "general", label: "启用 Chat 模式", type: "boolean", env: "OWC_CHAT_MODE_ENABLED", defaultValue: false, restartRequired: false, fromEnv: envBoolean, description: "默认关闭；开启后界面显示 Chat / Workbench 模式切换，可使用 ChatGPT 风格对话模式" },
  // 离线模式（热生效）：只关 server 自身的遥测/更新/同步类出站（更新检查、远程目录/定价后台同步、
  // 汇率在线刷新）；provider API、web_search/web_fetch、MCP 与扩展联网等用户/agent 主动网络行为不受影响
  { key: "offlineMode", group: "general", label: "离线模式", type: "boolean", env: "OWC_OFFLINE", defaultValue: false, restartRequired: false, fromEnv: envBoolean, description: "关闭 server 自身的启动期/周期性出站：更新检查、远程模型目录/定价后台同步、汇率在线刷新；不影响模型 API、联网搜索/抓取、MCP 与扩展联网" },
  // 执行器
  { key: "corePath", group: "executor", label: "执行器路径", type: "text", env: "OWC_CORE_PATH", defaultValue: "../build/Debug/owc-exec.exe", runtimeDefault: () => defaultCorePath(), restartRequired: true, validate: requireNonEmpty },
  { key: "coreRequestTimeoutMs", group: "executor", label: "执行器请求超时 (ms)", type: "number", env: "OWC_CORE_REQUEST_TIMEOUT_MS", defaultValue: 130_000, restartRequired: false, fromEnv: envNumber },
  { key: "sandboxAllowPaths", group: "executor", label: "沙盒额外允许目录", type: "pathList", env: "OWC_SANDBOX_ALLOW_PATHS", defaultValue: [], restartRequired: true, fromEnv: envPathList, validate: requirePathList, description: "每行一个目录，最多 16 个；执行时与会话工作目录合并并去重" },
  // 目录浏览根（热生效）：新建会话对话框的目录浏览器可遍历范围；留空默认家目录
  { key: "browseRoots", group: "executor", label: "目录浏览根", type: "pathList", env: "OWC_BROWSE_ROOTS", defaultValue: [], restartRequired: false, fromEnv: envPathList, validate: requirePathList, description: "新建会话时目录浏览器可遍历的根目录列表，每行一个绝对路径；留空则默认为用户家目录" },
  // filtered 网络档（Windows AppContainer）的 sidecar 代理拦截清单：热生效，sidecar 按 mtime 自重读
  { key: "sandboxProxyDenyList", group: "executor", label: "沙盒代理拦截域名", type: "pathList", env: "OWC_SANDBOX_PROXY_DENY_LIST", defaultValue: [], restartRequired: false, fromEnv: envDomainList, validate: requireDomainList, description: "filtered 网络档生效：每行一个域名（如 example.com，含其子域名），最多 64 个；命中的请求被沙盒代理拒绝（403），保存后对活跃会话热生效" },
  { key: "pythonEnv", group: "executor", label: "Python 环境", type: "select", env: "OWC_PYTHON_ENV", defaultValue: "global", restartRequired: false, options: PYTHON_ENV_OPTIONS, description: "全局默认：bash 工具的 python 运行环境。global = 本机已有环境；uv-workspace = 在项目工作区 .owc/venv 创建 uv 虚拟环境；uv-config = 在数据目录 venvs/ 创建 uv 虚拟环境。会话可在顶栏单独覆盖" },
  { key: "nodeEnv", group: "executor", label: "Node 环境", type: "select", env: "OWC_NODE_ENV", defaultValue: "global", restartRequired: false, options: NODE_ENV_OPTIONS, description: "全局默认：bash 工具的 node 运行环境。global = 本机已有环境；project = 工作区 node_modules/.bin 前置 PATH；fnm / nvm = 版本管理器激活（fnm 不支持 cmd；nvm 仅 POSIX bash/sh）。会话可在顶栏单独覆盖" },
  // Job Object 资源限制（仅 Windows，重启生效）：注入 CoreRouter 全局下发，留空由 core 用默认值
  { key: "jobObjectMemoryMB", group: "executor", label: "Job 内存上限 (MB)", type: "number", env: "OWC_JOB_MEMORY_MB", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMemoryMB, description: "进程树提交内存上限，缺省 4096；仅 Windows（Job Object）生效" },
  { key: "jobObjectMaxProcesses", group: "executor", label: "Job 进程数上限", type: "number", env: "OWC_JOB_MAX_PROCESSES", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMaxProcesses, description: "进程树活跃进程上限，缺省 64；仅 Windows（Job Object）生效" },
  { key: "gcMaxBytes", group: "service", label: "存储上限 (字节)", type: "number", env: "OWC_GC_MAX_BYTES", defaultValue: 2_147_483_648, restartRequired: false, fromEnv: envNumber, description: "会话 artifacts 全局 LRU 上限，超出后从最旧开始清理" },
  // 监听（重启生效）；Web 端归入"远程访问"页签
  { key: "host", group: "network", label: "监听地址", type: "text", env: "OWC_HOST", defaultValue: "127.0.0.1", restartRequired: true, validate: requireNonEmpty },
  { key: "port", group: "network", label: "监听端口", type: "number", env: "OWC_PORT", defaultValue: 3210, restartRequired: true, fromEnv: envNumber, validate: requirePort },
  {
    key: "dataDir",
    group: "service",
    label: "数据目录",
    type: "text",
    env: "OWC_DATA_DIR",
    defaultValue: "../.openwebcode",
    restartRequired: true,
    validate: requireNonEmpty,
    description: "显式 OWC_DATA_DIR 优先；安装启动器未设置时注入 Windows %USERPROFILE%\\openwebcode 或 Linux ${XDG_DATA_HOME:-~/.local/share}/openwebcode。仅直接运行 server/dist/index.js 才以相对 server 目录的 ../.openwebcode 作为启动/设置目录；环境变量未设时，此处保存的值会在重启后决定业务数据目录。建议填写绝对路径。",
  },
  // 汇率（重启生效）
  { key: "exchangeRateUrl", group: "exchangeRate", label: "汇率接口 URL", type: "text", env: "OWC_EXCHANGE_RATE_URL", defaultValue: null, restartRequired: true, validate: requireHttpUrl },
  { key: "exchangeRateTimeoutMs", group: "exchangeRate", label: "汇率请求超时 (ms)", type: "number", env: "OWC_EXCHANGE_RATE_TIMEOUT_MS", defaultValue: 5_000, restartRequired: true, fromEnv: envNumber },
  { key: "fixedUsdCnyRate", group: "exchangeRate", label: "固定美元汇率", type: "text", env: "OWC_USD_CNY_RATE", defaultValue: null, restartRequired: true, validate: requirePositiveDecimal, description: "填写后跳过在线汇率" },
  // 更新检查（默认关闭，热生效）：周期性查询 GitHub Releases 最新版本，结果仅在设置页静默展示
  { key: "updateCheckEnabled", group: "updateCheck", label: "启用更新检查", type: "boolean", env: "OWC_UPDATE_CHECK_ENABLED", defaultValue: false, restartRequired: false, fromEnv: envBoolean, description: "默认关闭；启用后周期性查询 GitHub Releases 最新版本" },
  { key: "updateCheckUrl", group: "updateCheck", label: "更新检查 URL", type: "text", env: "OWC_UPDATE_CHECK_URL", defaultValue: "https://api.github.com/repos/snnh/openwebcode/releases/latest", restartRequired: false, validate: requireHttpUrl, description: "GitHub Releases API 端点" },
  { key: "updateCheckIntervalHours", group: "updateCheck", label: "检查间隔（小时）", type: "number", env: "OWC_UPDATE_CHECK_INTERVAL_HOURS", defaultValue: 24, restartRequired: false, fromEnv: envUpdateCheckIntervalHours, validate: requireUpdateCheckIntervalHours, description: "0 表示仅手动检查；最大 720 小时" },
  // 出站代理（热生效）：作用于模型 API、联网搜索/抓取、更新检测与在线更新等全部 Node 侧出站请求。
  // 代理 URL 可能含凭据，按 secret 处理（view 仅返回脱敏值，自定义 mask 保留 host 便于辨认）。
  { key: "proxyMode", group: "proxy", label: "出站代理模式", type: "select", env: "OWC_PROXY_MODE", defaultValue: "env", restartRequired: false, options: PROXY_MODE_OPTIONS, fromEnv: envProxyMode, description: "off = 全部直连；env = 跟随 HTTPS_PROXY/HTTP_PROXY/NO_PROXY 环境变量；custom = 使用下方自定义代理地址" },
  { key: "proxyHttp", group: "proxy", label: "HTTP 代理", type: "secret", env: "OWC_PROXY_HTTP", defaultValue: null, restartRequired: false, validate: requireHttpUrl, mask: sanitizeProxyUrl, description: "形如 http://127.0.0.1:7890，可含凭据；仅自定义模式生效；HTTPS 代理留空时兼作其回退" },
  { key: "proxyHttps", group: "proxy", label: "HTTPS 代理", type: "secret", env: "OWC_PROXY_HTTPS", defaultValue: null, restartRequired: false, validate: requireHttpUrl, mask: sanitizeProxyUrl, description: "访问 https 目标时使用的代理；留空回退 HTTP 代理" },
  { key: "proxyNoProxy", group: "proxy", label: "代理例外列表", type: "text", env: "OWC_PROXY_NO_PROXY", defaultValue: null, restartRequired: false, validate: requireNoProxyList, description: "逗号分隔的主机名或域名后缀（如 internal.example.com），这些地址跳过代理；本机回环地址始终跳过" },
  // 联网搜索模式（热生效）：local = 本地 web_search 工具经联网服务商执行；model-api = 由模型服务商在
  // 服务端执行（请求级 serverWebSearch 标记，仅 OpenAI Responses 接口生效，此时本地 web_search 不再注入，
  // 非 Responses 接口的会话将没有搜索能力）；web_fetch 两种模式均不受影响。
  { key: "webSearchMode", group: "webSearch", label: "联网搜索模式", type: "select", env: "OWC_WEB_SEARCH_MODE", defaultValue: "local", restartRequired: false, options: WEB_SEARCH_MODE_OPTIONS, description: "local = 本地 web_search 工具经联网服务商执行；model-api = 由模型服务商在服务端执行（仅 OpenAI Responses 接口生效，此时本地 web_search 不再注入）；web_fetch 两种模式均可用" },
];

const FIELD_MAP = new Map(FIELDS.map((field) => [field.key, field]));

/**
 * 安装目录默认配置（config/defaults.json，随构建发布、跟随更新）。
 * 数据目录的 server-settings.json 只存用户覆盖；effectiveValue 按
 * env > 用户覆盖 > 安装默认 > 代码兜底（FIELDS.defaultValue）组合。
 * defaults.json 与 FIELDS.defaultValue 由测试强制保持一致。
 */
const INSTALL_DEFAULTS = new Map<string, SettingValue>(
  Object.entries(installDefaultsDocument as Record<string, unknown>)
    .filter(([, value]) => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
      (Array.isArray(value) && value.every((entry) => typeof entry === "string")))
    .map(([key, value]) => [key, value as SettingValue]),
);

/** 代码内默认值（FIELDS.defaultValue）；测试用于校验与 config/defaults.json 保持一致。 */
export const CODE_DEFAULTS: ReadonlyMap<string, SettingValue | null> = new Map(FIELDS.map((field) => [field.key, field.defaultValue]));

function maskSecret(value: string): string {
  if (value.length <= 12) return "••••••";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function sameSettingValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

export class SettingsService {
  private overrides: Record<string, SettingValue> = {};
  private deps: RuntimeDependencies | undefined;

  private constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly filePath: string,
  ) {}

  static async load(options: { env: NodeJS.ProcessEnv; filePath: string }): Promise<SettingsService> {
    const service = new SettingsService(options.env, options.filePath);
    try {
      const raw = await readFile(options.filePath, "utf8");
      const parsed = JSON.parse(raw) as { overrides?: unknown };
      if (parsed && typeof parsed === "object" && parsed.overrides && typeof parsed.overrides === "object") {
        for (const [key, value] of Object.entries(parsed.overrides as Record<string, unknown>)) {
          // 未知键不再进入内存，并会在下一次持久化时从文件中消失；
          // 非法值同样忽略，避免损坏的 interval 被 Node timer 钳制为 1 ms。
          const field = FIELD_MAP.get(key);
          if (!field) continue;
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
              (Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
            try {
              service.validateValue(field, value);
              service.overrides[key] = value;
            } catch {
              // Invalid persisted values fall back to the field default.
            }
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`[settings] 无法读取 ${options.filePath}，按无覆盖处理：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return service;
  }

  bind(deps: RuntimeDependencies): void {
    this.deps = deps;
  }

  private envValue(field: FieldSpec): SettingValue | undefined {
    const raw = this.env[field.env];
    if (raw === undefined || raw === "") return undefined;
    if (field.fromEnv) return field.fromEnv(raw);
    return raw;
  }

  private source(field: FieldSpec): SettingSource {
    if (this.envValue(field) !== undefined) return "env";
    if (field.key in this.overrides) return "file";
    return "default";
  }

  /** 安装目录默认值（config/defaults.json）；缺失时回退代码内 FIELDS.defaultValue。 */
  private installDefault(field: FieldSpec): SettingValue | null {
    return INSTALL_DEFAULTS.has(field.key) ? INSTALL_DEFAULTS.get(field.key)! : field.defaultValue;
  }

  private effectiveValue(field: FieldSpec): SettingValue | null {
    const fromEnv = this.envValue(field);
    if (fromEnv !== undefined) return fromEnv;
    if (field.key in this.overrides) return this.overrides[field.key]!;
    return field.runtimeDefault?.() ?? this.installDefault(field);
  }

  private optionsFor(field: FieldSpec): SettingOptionView[] | undefined {
    if (!MODEL_SELECTION_KEYS.has(field.key)) {
      return field.options?.map((value) => ({ value, label: value }));
    }
    const enabled = new Set(this.deps?.profiles?.modelProfiles()
      .filter((profile) => profile.enabled)
      .map((profile) => profile.id) ?? []);
    const options = (this.deps?.models?.list() ?? [])
      .filter((model) => enabled.has(model.provider))
      .map((model) => ({
        value: encodeFastModelSelection(model.provider, model.id),
        label: `${model.id}【${model.provider}】`,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
    const current = this.effectiveValue(field);
    if (typeof current === "string" && decodeFastModelSelection(current) && !options.some((option) => option.value === current)) {
      const [provider, model] = decodeFastModelSelection(current)!;
      options.unshift({ value: current, label: `${model}【${provider}】（不可用）` });
    }
    return options;
  }

  effective(): ServerConfig {
    const value = (key: string) => this.effectiveValue(FIELD_MAP.get(key)!);
    const exchangeRateUrl = value("exchangeRateUrl");
    const fixedUsdCnyRate = value("fixedUsdCnyRate");
    const fastModelSelection = decodeFastModelSelection(value("fastModel"));
    const defaultModelSelection = decodeFastModelSelection(value("defaultModel"));
    const roleModelPremium = decodeFastModelSelection(value("roleModelPremium"));
    const roleModelBalanced = decodeFastModelSelection(value("roleModelBalanced"));
    const roleModelCheap = decodeFastModelSelection(value("roleModelCheap"));
    const fastModelThinking = value("fastModelThinking");
    const fastModelEffort = value("fastModelEffort");
    const defaultEffort = value("defaultEffort");
    const snapshotBackend = value("snapshotBackend");
    const jobObjectMemoryMB = value("jobObjectMemoryMB");
    const jobObjectMaxProcesses = value("jobObjectMaxProcesses");
    const sandboxAllowPaths = value("sandboxAllowPaths") as string[];
    const browseRoots = value("browseRoots") as string[];
    const sandboxProxyDenyList = (value("sandboxProxyDenyList") as string[]).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    const catalogSyncUrl = value("catalogSyncUrl");
    const pricingSyncUrl = value("pricingSyncUrl");
    const proxyHttp = value("proxyHttp");
    const proxyHttps = value("proxyHttps");
    const proxyNoProxy = value("proxyNoProxy");
    const host = value("host") as string;
    // The listener address is editable in persisted settings. The access token
    // stays environment-overridable but is auto-generated and persisted on
    // non-loopback startup (access-token.ts); allowed origins fall back to
    // same-origin auto-allow unless set explicitly. Re-run their validation
    // against the effective host so a saved remote address cannot bypass the
    // startup guard in loadConfig().
    const listenerSecurity = loadConfig({ ...this.env, OWC_HOST: host });
    return {
      host,
      port: value("port") as number,
      ...(listenerSecurity.accessToken ? { accessToken: listenerSecurity.accessToken } : {}),
      allowedOrigins: listenerSecurity.allowedOrigins,
      ...(listenerSecurity.autoAllowSameOrigin ? { autoAllowSameOrigin: true } : {}),
      corePath: value("corePath") as string,
      dataDir: value("dataDir") as string,
      coreRequestTimeoutMs: value("coreRequestTimeoutMs") as number,
      gcMaxBytes: value("gcMaxBytes") as number,
      agentMaxTurns: value("agentMaxTurns") as number,
      defaultLanguage: value("defaultLanguage") as string,
      defaultCurrency: value("defaultCurrency") as "USD" | "CNY",
      pythonEnv: value("pythonEnv") as PythonEnv,
      nodeEnv: value("nodeEnv") as NodeEnv,
      exchangeRate: {
        ...(typeof exchangeRateUrl === "string" ? { url: exchangeRateUrl } : {}),
        timeoutMs: value("exchangeRateTimeoutMs") as number,
        ...(typeof fixedUsdCnyRate === "string" ? { fixedUsdCnyRate } : {}),
      },
      models: {
        ...(typeof catalogSyncUrl === "string" ? { catalogSyncUrl } : {}),
        ...(typeof pricingSyncUrl === "string" ? { pricingSyncUrl } : {}),
        syncIntervalMinutes: value("syncIntervalMinutes") as number,
      },
      updateCheck: {
        enabled: value("updateCheckEnabled") as boolean,
        ...(typeof value("updateCheckUrl") === "string" ? { url: value("updateCheckUrl") as string } : {}),
        intervalHours: value("updateCheckIntervalHours") as number,
      },
      offlineMode: value("offlineMode") as boolean,
      proxy: {
        mode: value("proxyMode") as ProxyMode,
        ...(typeof proxyHttp === "string" ? { httpProxy: proxyHttp } : {}),
        ...(typeof proxyHttps === "string" ? { httpsProxy: proxyHttps } : {}),
        ...(typeof proxyNoProxy === "string" ? { noProxy: proxyNoProxy } : {}),
      },
      ...(defaultModelSelection
        ? { defaultModel: { provider: defaultModelSelection[0], model: defaultModelSelection[1] } }
        : {}),
      // 新建会话默认（app.ts 创建路由消费；defaultEffort 的 none = 不设置，不进 ServerConfig）
      // 存储前校验：仅枚举内合法力度进 ServerConfig（非法值如 env 直写在此丢弃，app.ts 仍有兜底校验）
      ...(typeof defaultEffort === "string" && defaultEffort !== "none" && EFFORT_OPTIONS.includes(defaultEffort)
        ? { defaultEffort: defaultEffort as EffortLevel }
        : {}),
      defaultSnapshotMode: value("defaultSnapshotMode") as "auto" | "manual",
      // 快照后端偏好（app.ts 创建路由消费；auto = 探测链自动选择，不进 ServerConfig）
      ...(typeof snapshotBackend === "string" && (SNAPSHOT_BACKENDS as readonly string[]).includes(snapshotBackend)
        ? { snapshotBackend: snapshotBackend as SnapshotBackendName }
        : {}),
      // 联网搜索模式（agent-runner 消费；仅枚举内合法值进 ServerConfig，非法值回落 local）
      webSearchMode: value("webSearchMode") === "model-api" ? "model-api" : "local",
      ...(roleModelPremium || roleModelBalanced || roleModelCheap
        ? {
            roleModels: {
              ...(roleModelPremium ? { premium: { provider: roleModelPremium[0], model: roleModelPremium[1] } } : {}),
              ...(roleModelBalanced ? { balanced: { provider: roleModelBalanced[0], model: roleModelBalanced[1] } } : {}),
              ...(roleModelCheap ? { cheap: { provider: roleModelCheap[0], model: roleModelCheap[1] } } : {}),
            },
          }
        : {}),
      ...(sandboxAllowPaths.length > 0 || typeof jobObjectMemoryMB === "number" || typeof jobObjectMaxProcesses === "number"
        ? {
            sandbox: {
              ...(sandboxAllowPaths.length > 0 ? { allowPaths: sandboxAllowPaths } : {}),
              ...(typeof jobObjectMemoryMB === "number" || typeof jobObjectMaxProcesses === "number"
                ? { jobObject: {
                    ...(typeof jobObjectMemoryMB === "number" ? { memoryMB: jobObjectMemoryMB } : {}),
                    ...(typeof jobObjectMaxProcesses === "number" ? { maxProcesses: jobObjectMaxProcesses } : {}),
                  } }
                : {}),
            },
          }
        : {}),
      // filtered 网络档 sidecar 拦截清单（filtered-proxy 管理器现读；空表不进 ServerConfig）
      ...(sandboxProxyDenyList.length > 0 ? { sandboxProxyDenyList } : {}),
      // 目录浏览根（app.ts /api/browse 路由消费；空 = 默认家目录，不进 ServerConfig）
      ...(browseRoots.length > 0 ? { browseRoots } : {}),
      ...(fastModelSelection
        ? {
            fastModel: {
              provider: fastModelSelection[0],
              model: fastModelSelection[1],
              ...(fastModelThinking === "adaptive" || fastModelThinking === "enabled" || fastModelThinking === "disabled"
                ? { thinking: fastModelThinking }
                : {}),
              ...(fastModelEffort === "low" || fastModelEffort === "medium" || fastModelEffort === "high" || fastModelEffort === "xhigh" || fastModelEffort === "max" || fastModelEffort === "ultra"
                ? { effort: fastModelEffort }
                : {}),
            },
        }
        : {}),
    };
  }

  view(): SettingsView {
    return {
      groups: GROUPS.map((group) => ({
        ...group,
        fields: FIELDS.filter((field) => field.group === group.id).map((field) => {
          const source = this.source(field);
          const value = this.effectiveValue(field);
          const options = this.optionsFor(field);
          const base = {
            key: field.key,
            label: field.label,
            type: field.type,
            ...(options !== undefined ? { options } : {}),
            source,
            editable: source !== "env",
            restartRequired: field.restartRequired,
            nullable: field.defaultValue === null,
            installDefault: this.installDefault(field),
            ...(field.description ? { description: field.description } : {}),
          } satisfies Omit<SettingsFieldView, "value" | "hasValue" | "masked">;
          if (field.type === "secret") {
            const hasValue = typeof value === "string" && value.length > 0;
            return { ...base, value: null, hasValue, ...(hasValue ? { masked: (field.mask ?? maskSecret)(value as string) } : {}) };
          }
          return { ...base, value, hasValue: value !== null };
        }),
      })).filter((group) => group.fields.length > 0),
    };
  }

  async update(patch: Record<string, unknown>): Promise<SettingsView> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new SettingsValidationError("overrides 必须是对象");
    }
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      const field = FIELD_MAP.get(key);
      if (!field) throw new SettingsValidationError(`未知配置项：${key}`);
      if (this.envValue(field) !== undefined) {
        throw new SettingsValidationError(`${field.label} 由环境变量 ${field.env} 控制，无法在界面修改`);
      }
      if (value === null) continue;
      this.validateValue(field, value);
    }
    const next = { ...this.overrides };
    const changed: string[] = [];
    for (const [key, value] of entries) {
      const field = FIELD_MAP.get(key)!;
      // 写入与安装默认值相同的值视为清除覆盖，避免无意义的"已覆盖"残留
      if (value === null || sameSettingValue(value, this.installDefault(field))) {
        if (key in next) {
          delete next[key];
          changed.push(key);
        }
      } else if (!sameSettingValue(next[key], value)) {
        next[key] = value as SettingValue;
        changed.push(key);
      }
    }
    if (changed.length === 0) return this.view();
    this.validateProxyCombination(next);
    this.overrides = next;
    await this.persist();
    this.hotApply(changed);
    this.deps?.events.publish({
      source: "server",
      type: "server.settings_updated",
      payload: { keys: changed },
    });
    return this.view();
  }

  /** Names of chat providers whose required connection credentials are configured. */
  configuredProviderNames(): string[] {
    if (this.deps?.profiles) {
      return this.deps.profiles.modelProfiles().filter((profile) => profile.enabled).map((profile) => profile.id);
    }
    return this.deps?.providers.list() ?? [];
  }

  private hotApply(changed: string[]): void {
    if (!this.deps) return;
    if (changed.includes("defaultLanguage")) this.deps.agent.setDefaultLanguage(this.effective().defaultLanguage);
    if (changed.includes("coreRequestTimeoutMs")) this.deps.core.setRequestTimeoutMs(this.effective().coreRequestTimeoutMs);
    if (changed.some((key) => key.startsWith("fastModel")) && this.deps.fastModel) {
      this.deps.fastModel.setConfig(this.effective().fastModel);
    }
    if (changed.includes("gcMaxBytes") && this.deps.gc) {
      const gc = this.deps.gc;
      gc.setMaxBytes(this.effective().gcMaxBytes);
      void gc.collect().catch((error: unknown) => process.stderr.write(`[settings] 存储 GC 失败：${error instanceof Error ? error.message : String(error)}\n`));
    }
    // 更新检查热应用；离线模式下整体关闭（含手动 refresh——更新检查属纯遥测，无用户刚需入口）
    if ((changed.some((key) => key.startsWith("updateCheck")) || changed.includes("offlineMode")) && this.deps.updateChecker) {
      const cfg = this.effective().updateCheck;
      const enabled = cfg.enabled && !this.effective().offlineMode;
      this.deps.updateChecker.configure({ ...cfg, enabled });
      if (enabled) void this.deps.updateChecker.refresh().catch(() => undefined);
    }
    // 出站代理热重应用：全局 dispatcher 立即替换，摘要已脱敏可写日志
    if (changed.some((key) => key.startsWith("proxy"))) {
      try {
        const description = (this.deps.applyProxy ?? applyProxyConfig)(this.effective().proxy);
        process.stderr.write(`[proxy] ${description.summary}\n`);
      } catch (error) {
        process.stderr.write(`[proxy] 代理配置应用失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    // filtered 拦截清单热生效：重写所有活跃 filtered 会话的 deny 文件（sidecar 按 mtime 自重读）
    if (changed.includes("sandboxProxyDenyList") && this.deps.sandboxProxy) {
      void this.deps.sandboxProxy.refreshDenyFiles().catch((error: unknown) => process.stderr.write(`[settings] 沙盒代理拦截清单热更新失败：${error instanceof Error ? error.message : String(error)}\n`));
    }
    // defaultCurrency 无需主动推送：app 路由经 getPreferences 每次实时读取
  }

  /**
   * 跨字段校验：自定义代理模式下 HTTP/HTTPS 代理至少一个非空。
   * 按「env > 新覆盖 > 安装默认」计算保存后的生效值（overrides 尚未替换）。
   */
  private validateProxyCombination(next: Record<string, SettingValue>): void {
    const modeField = FIELD_MAP.get("proxyMode")!;
    const mode = this.envValue(modeField) ?? next["proxyMode"] ?? this.installDefault(modeField);
    if (mode !== "custom") return;
    const httpProxy = this.envValue(FIELD_MAP.get("proxyHttp")!) ?? next["proxyHttp"];
    const httpsProxy = this.envValue(FIELD_MAP.get("proxyHttps")!) ?? next["proxyHttps"];
    if (typeof httpProxy !== "string" && typeof httpsProxy !== "string") {
      throw new SettingsValidationError("自定义代理模式下，HTTP/HTTPS 代理至少填写一个");
    }
  }

  private validateValue(field: FieldSpec, value: unknown): void {
    switch (field.type) {
      case "text":
      case "secret":
        if (typeof value !== "string" || value.trim() === "") {
          throw new SettingsValidationError(`${field.label} 必须是非空字符串（清除请传 null）`);
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (field.key === "syncIntervalMinutes" ? 0 : 1) ||
            (field.key === "syncIntervalMinutes" && value > MAX_SYNC_INTERVAL_MINUTES)) {
          throw new SettingsValidationError(field.key === "syncIntervalMinutes"
            ? `${field.label} 必须是 0–${MAX_SYNC_INTERVAL_MINUTES} 的整数`
            : `${field.label} 必须是正整数`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new SettingsValidationError(`${field.label} 必须是布尔值`);
        break;
      case "select":
        if (typeof value !== "string") throw new SettingsValidationError(`${field.label} 必须是字符串`);
        if (MODEL_SELECTION_KEYS.has(field.key)) {
          if (!decodeFastModelSelection(value)) throw new SettingsValidationError(`${field.label}选择无效`);
          if (this.deps && !this.optionsFor(field)?.some((option) => option.value === value)) {
            throw new SettingsValidationError(`${field.label}必须来自已启用服务商的模型目录`);
          }
        } else if (!field.options?.includes(value)) {
          throw new SettingsValidationError(`${field.label} 必须是 ${field.options?.join(" / ")} 之一`);
        }
        break;
      case "pathList":
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
          throw new SettingsValidationError(`${field.label} 必须是非空字符串数组`);
        }
        break;
    }
    field.validate?.(value as SettingValue);
  }

  private async persist(): Promise<void> {
    // server-settings.json 可能含敏感覆盖：目录 0700、文件 0600（POSIX；Windows no-op）
    await ensureDirWithMode(path.dirname(this.filePath), 0o700);
    const document = { version: 1, updatedAt: new Date().toISOString(), overrides: this.overrides };
    await writeUtf8Atomically(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
}
