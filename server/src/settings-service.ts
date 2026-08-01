import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "./atomic-file.js";
import type { AgentRunner } from "./agent/agent-runner.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "./remote-sync-scheduler.js";
import type { CoreClientLike } from "./core-client.js";
import type { EventBus } from "./events/event-bus.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { StorageGC } from "./storage-gc.js";
import type { FastModelClient } from "./fast-model.js";
import type { ProviderProfilesService } from "./provider-profiles.js";
import type { ModelRegistry } from "./context/model-registry.js";
import type { UpdateChecker } from "./update-checker.js";
import type { PythonEnv } from "./sessions/types.js";
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
  restartRequired: boolean;
  options?: string[];
  fromEnv?: (raw: string) => SettingValue | undefined;
  validate?: (value: SettingValue) => void;
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
}

const GROUPS = [
  { id: "models", label: "模型接入" },
  { id: "fastModel", label: "快速模型" },
  { id: "general", label: "语言与货币" },
  { id: "executor", label: "执行器" },
  { id: "service", label: "存储" },
  // 监听地址/端口单独分组：Web 端在"远程访问"页签渲染；分组 id 保持稳定，渲染位置由 Web 端决定
  { id: "network", label: "监听与端口" },
  { id: "exchangeRate", label: "汇率" },
  { id: "updateCheck", label: "更新检查" },
];

const LANGUAGE_OPTIONS = ["zh-CN", "en-US", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "ru-RU"];
const PYTHON_ENV_OPTIONS = ["global", "uv-workspace", "uv-config"];
const THINKING_OPTIONS = ["disabled", "adaptive", "enabled"];
const EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

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

function requireFastModelSelection(value: SettingValue): void {
  if (!decodeFastModelSelection(value)) throw new SettingsValidationError("快速模型选择无效");
}

function requireFastModelMaxTokens(value: SettingValue): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64_000) {
    throw new SettingsValidationError("快速模型最大输出需为 1–64000 的整数");
  }
}

function requirePathList(value: SettingValue): void {
  if (!Array.isArray(value) || value.length > 16 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new SettingsValidationError("允许目录必须是最多 16 项的非空路径列表");
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

const FIELDS: FieldSpec[] = [
  // 模型目录同步；模型服务商连接由 provider-profiles.json 独立管理。
  { key: "catalogSyncUrl", group: "models", label: "远程模型目录 URL", type: "text", env: "OWC_MODELS_CATALOG_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型目录" },
  { key: "pricingSyncUrl", group: "models", label: "远程定价目录 URL", type: "text", env: "OWC_MODELS_PRICING_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型定价" },
  { key: "syncIntervalMinutes", group: "models", label: "远程同步间隔（分钟）", type: "number", env: "OWC_MODELS_SYNC_INTERVAL_MINUTES", defaultValue: 0, restartRequired: false, fromEnv: envSyncIntervalMinutes, validate: requireSyncIntervalMinutes, description: `0 表示仅手动同步；大于 0 时按此间隔自动同步，最大 ${MAX_SYNC_INTERVAL_MINUTES} 分钟` },
  // 内部低延迟任务复用已启用模型服务商，不维护第二套端点或密钥。
  { key: "fastModel", group: "fastModel", label: "快速模型", type: "select", env: "OWC_FAST_MODEL", defaultValue: null, restartRequired: false, validate: requireFastModelSelection, description: "用于上下文压缩和内容透镜；模型来自已启用服务商的统一模型目录" },
  { key: "fastModelThinking", group: "fastModel", label: "思考", type: "select", env: "OWC_FAST_MODEL_THINKING", defaultValue: "disabled", restartRequired: false, options: THINKING_OPTIONS },
  { key: "fastModelEffort", group: "fastModel", label: "力度", type: "select", env: "OWC_FAST_MODEL_EFFORT", defaultValue: "none", restartRequired: false, options: EFFORT_OPTIONS },
  { key: "fastModelMaxTokens", group: "fastModel", label: "最大输出上限", type: "number", env: "OWC_FAST_MODEL_MAX_TOKENS", defaultValue: 4_096, restartRequired: false, fromEnv: envNumber, validate: requireFastModelMaxTokens, description: "内部任务的输出 token 硬上限；具体任务可以使用更小上限" },
  // 通用（热生效）
  { key: "defaultLanguage", group: "general", label: "默认语言", type: "select", env: "OWC_DEFAULT_LANGUAGE", defaultValue: "zh-CN", restartRequired: false, options: LANGUAGE_OPTIONS },
  { key: "defaultCurrency", group: "general", label: "默认货币", type: "select", env: "OWC_DEFAULT_CURRENCY", defaultValue: "CNY", restartRequired: false, options: ["USD", "CNY"], fromEnv: envCurrency },
  // 执行器
  { key: "corePath", group: "executor", label: "执行器路径", type: "text", env: "OWC_CORE_PATH", defaultValue: "../build/Debug/owc-exec.exe", restartRequired: true, validate: requireNonEmpty },
  { key: "coreRequestTimeoutMs", group: "executor", label: "执行器请求超时 (ms)", type: "number", env: "OWC_CORE_REQUEST_TIMEOUT_MS", defaultValue: 130_000, restartRequired: false, fromEnv: envNumber },
  { key: "sandboxAllowPaths", group: "executor", label: "AppContainer 额外允许目录", type: "pathList", env: "OWC_SANDBOX_ALLOW_PATHS", defaultValue: [], restartRequired: true, fromEnv: envPathList, validate: requirePathList, description: "每行一个目录，最多 16 个；执行时与会话工作目录合并并去重" },
  { key: "pythonEnv", group: "executor", label: "Python 环境", type: "select", env: "OWC_PYTHON_ENV", defaultValue: "global", restartRequired: false, options: PYTHON_ENV_OPTIONS, description: "全局默认：bash 工具的 python 运行环境。global = 本机已有环境；uv-workspace = 在项目工作区 .owc/venv 创建 uv 虚拟环境；uv-config = 在数据目录 venvs/ 创建 uv 虚拟环境。会话可在顶栏单独覆盖" },
  // Job Object 资源限制（仅 Windows，重启生效）：注入 CoreRouter 全局下发，留空由 core 用默认值
  { key: "jobObjectMemoryMB", group: "executor", label: "Job 内存上限 (MB)", type: "number", env: "OWC_JOB_MEMORY_MB", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMemoryMB, description: "Job Object 提交内存上限，缺省 4096" },
  { key: "jobObjectMaxProcesses", group: "executor", label: "Job 进程数上限", type: "number", env: "OWC_JOB_MAX_PROCESSES", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMaxProcesses, description: "Job Object 活跃进程上限，缺省 64" },
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
    return this.installDefault(field);
  }

  private optionsFor(field: FieldSpec): SettingOptionView[] | undefined {
    if (field.key !== "fastModel") {
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
    const fastModelThinking = value("fastModelThinking");
    const fastModelEffort = value("fastModelEffort");
    const jobObjectMemoryMB = value("jobObjectMemoryMB");
    const jobObjectMaxProcesses = value("jobObjectMaxProcesses");
    const sandboxAllowPaths = value("sandboxAllowPaths") as string[];
    const catalogSyncUrl = value("catalogSyncUrl");
    const pricingSyncUrl = value("pricingSyncUrl");
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
      defaultLanguage: value("defaultLanguage") as string,
      defaultCurrency: value("defaultCurrency") as "USD" | "CNY",
      pythonEnv: value("pythonEnv") as PythonEnv,
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
              maxTokens: value("fastModelMaxTokens") as number,
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
            return { ...base, value: null, hasValue, ...(hasValue ? { masked: maskSecret(value as string) } : {}) };
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
    if (changed.some((key) => key.startsWith("updateCheck")) && this.deps.updateChecker) {
      const cfg = this.effective().updateCheck;
      this.deps.updateChecker.configure(cfg);
      if (cfg.enabled) void this.deps.updateChecker.refresh().catch(() => undefined);
    }
    // defaultCurrency 无需主动推送：app 路由经 getPreferences 每次实时读取
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
        if (field.key === "fastModel") {
          if (!decodeFastModelSelection(value)) throw new SettingsValidationError("快速模型选择无效");
          if (this.deps && !this.optionsFor(field)?.some((option) => option.value === value)) {
            throw new SettingsValidationError("快速模型必须来自已启用服务商的模型目录");
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
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const document = { version: 1, updatedAt: new Date().toISOString(), overrides: this.overrides };
    await writeUtf8Atomically(this.filePath, `${JSON.stringify(document, null, 2)}\n`);
  }
}
