import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "./agent/agent-runner.js";
import { type ServerConfig } from "./config.js";
import { MAX_SYNC_INTERVAL_MINUTES } from "./remote-sync-scheduler.js";
import type { CoreClientLike } from "./core-client.js";
import type { EventBus } from "./events/event-bus.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { ModelRegistry } from "./context/model-registry.js";
import type { StorageGC } from "./storage-gc.js";
import type { Provider2Client } from "./provider2.js";

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export type SettingFieldType = "text" | "secret" | "number" | "boolean" | "select" | "pathList";
export type SettingValue = string | number | boolean | string[];
export type SettingSource = "default" | "env" | "file";

export interface SettingsFieldView {
  key: string;
  label: string;
  type: SettingFieldType;
  options?: string[];
  value: SettingValue | null;
  hasValue: boolean;
  masked?: string;
  source: SettingSource;
  editable: boolean;
  restartRequired: boolean;
  nullable: boolean;
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
  models?: ModelRegistry;
  gc?: StorageGC;
  provider2?: Provider2Client;
}

const GROUPS = [
  { id: "models", label: "模型接入" },
  { id: "provider2", label: "上下文压缩" },
  { id: "search", label: "网络搜索" },
  { id: "general", label: "语言与货币" },
  { id: "executor", label: "执行器" },
  { id: "service", label: "服务" },
  { id: "exchangeRate", label: "汇率" },
];

const LANGUAGE_OPTIONS = ["zh-CN", "en-US", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "ru-RU"];
const PROVIDER_KEYS = new Set(["anthropicApiKey", "anthropicBaseURL", "anthropicPromptCaching", "openaiBaseURL", "openaiApiKey"]);

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

function envBoolean(raw: string): SettingValue | undefined {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
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

const FIELDS: FieldSpec[] = [
  // 模型接入（热生效）
  { key: "anthropicApiKey", group: "models", label: "Anthropic API Key", type: "secret", env: "ANTHROPIC_API_KEY", defaultValue: null, restartRequired: false },
  { key: "anthropicBaseURL", group: "models", label: "Anthropic Base URL", type: "text", env: "ANTHROPIC_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空使用官方端点" },
  { key: "anthropicPromptCaching", group: "models", label: "Anthropic Prompt Caching", type: "boolean", env: "ANTHROPIC_PROMPT_CACHING", defaultValue: true, restartRequired: false, fromEnv: envBoolean },
  { key: "openaiBaseURL", group: "models", label: "OpenAI 兼容 Base URL", type: "text", env: "OPENAI_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "填写后启用 OpenAI 兼容接入" },
  { key: "openaiApiKey", group: "models", label: "OpenAI API Key", type: "secret", env: "OPENAI_API_KEY", defaultValue: null, restartRequired: false },
  { key: "catalogSyncUrl", group: "models", label: "远程模型目录 URL", type: "text", env: "OWC_MODELS_CATALOG_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型目录" },
  { key: "pricingSyncUrl", group: "models", label: "远程定价目录 URL", type: "text", env: "OWC_MODELS_PRICING_SYNC_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空则不从远程链接同步模型定价" },
  { key: "syncIntervalMinutes", group: "models", label: "远程同步间隔（分钟）", type: "number", env: "OWC_MODELS_SYNC_INTERVAL_MINUTES", defaultValue: 0, restartRequired: false, fromEnv: envSyncIntervalMinutes, validate: requireSyncIntervalMinutes, description: `0 表示仅手动同步；大于 0 时按此间隔自动同步，最大 ${MAX_SYNC_INTERVAL_MINUTES} 分钟` },
  // 上下文压缩 provider2（热生效）：快速廉价的 OpenAI 兼容端点，用于 compact/85% 水位强制压缩
  { key: "provider2BaseURL", group: "provider2", label: "provider2 Base URL", type: "text", env: "OWC_PROVIDER2_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "OpenAI 兼容端点；与模型名同时填写后启用" },
  { key: "provider2ApiKey", group: "provider2", label: "provider2 API Key", type: "secret", env: "OWC_PROVIDER2_API_KEY", defaultValue: null, restartRequired: false },
  { key: "provider2Model", group: "provider2", label: "provider2 模型", type: "text", env: "OWC_PROVIDER2_MODEL", defaultValue: null, restartRequired: false, description: "如 deepseek-chat / claude-haiku-4-5" },
  // 网络搜索（重启生效）
  { key: "searchProvider", group: "search", label: "搜索 Provider", type: "select", env: "OWC_SEARCH_PROVIDER", defaultValue: null, restartRequired: true, options: ["brave", "custom"] },
  { key: "searchApiKey", group: "search", label: "搜索 API Key", type: "secret", env: "OWC_SEARCH_API_KEY", defaultValue: null, restartRequired: true },
  { key: "searchBaseURL", group: "search", label: "搜索 Base URL", type: "text", env: "OWC_SEARCH_BASE_URL", defaultValue: null, restartRequired: true, validate: requireHttpUrl, description: "custom provider 的 HTTP 端点" },
  // 通用（热生效）
  { key: "defaultLanguage", group: "general", label: "默认语言", type: "select", env: "OWC_DEFAULT_LANGUAGE", defaultValue: "zh-CN", restartRequired: false, options: LANGUAGE_OPTIONS },
  { key: "defaultCurrency", group: "general", label: "默认货币", type: "select", env: "OWC_DEFAULT_CURRENCY", defaultValue: "CNY", restartRequired: false, options: ["USD", "CNY"], fromEnv: envCurrency },
  // 执行器
  { key: "corePath", group: "executor", label: "执行器路径", type: "text", env: "OWC_CORE_PATH", defaultValue: "../build/Debug/owc-exec.exe", restartRequired: true, validate: requireNonEmpty },
  { key: "coreRequestTimeoutMs", group: "executor", label: "执行器请求超时 (ms)", type: "number", env: "OWC_CORE_REQUEST_TIMEOUT_MS", defaultValue: 130_000, restartRequired: false, fromEnv: envNumber },
  { key: "sandboxAllowPaths", group: "executor", label: "AppContainer 额外允许目录", type: "pathList", env: "OWC_SANDBOX_ALLOW_PATHS", defaultValue: [], restartRequired: true, fromEnv: envPathList, validate: requirePathList, description: "每行一个目录，最多 16 个；执行时与会话工作目录合并并去重" },
  // Job Object 资源限制（仅 Windows，重启生效）：注入 CoreRouter 全局下发，留空由 core 用默认值
  { key: "jobObjectMemoryMB", group: "executor", label: "Job 内存上限 (MB)", type: "number", env: "OWC_JOB_MEMORY_MB", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMemoryMB, description: "Job Object 提交内存上限，缺省 4096" },
  { key: "jobObjectMaxProcesses", group: "executor", label: "Job 进程数上限", type: "number", env: "OWC_JOB_MAX_PROCESSES", defaultValue: null, restartRequired: true, fromEnv: envNumber, validate: requireJobMaxProcesses, description: "Job Object 活跃进程上限，缺省 64" },
  { key: "gcMaxBytes", group: "service", label: "存储上限 (字节)", type: "number", env: "OWC_GC_MAX_BYTES", defaultValue: 2_147_483_648, restartRequired: false, fromEnv: envNumber, description: "会话 artifacts 全局 LRU 上限，超出后从最旧开始清理" },
  // 服务（重启生效）
  { key: "host", group: "service", label: "监听地址", type: "text", env: "OWC_HOST", defaultValue: "127.0.0.1", restartRequired: true, validate: requireNonEmpty },
  { key: "port", group: "service", label: "监听端口", type: "number", env: "OWC_PORT", defaultValue: 3210, restartRequired: true, fromEnv: envNumber, validate: requirePort },
  {
    key: "dataDir",
    group: "service",
    label: "数据目录",
    type: "text",
    env: "OWC_DATA_DIR",
    defaultValue: "../.openwebcode",
    restartRequired: true,
    validate: requireNonEmpty,
    description: "显式 OWC_DATA_DIR 优先；安装启动器未设置时注入 Windows %LOCALAPPDATA%\\openwebcode 或 Linux ${XDG_DATA_HOME:-~/.local/share}/openwebcode。仅直接运行 server/dist/index.js 才以相对 server 目录的 ../.openwebcode 作为启动/设置目录；环境变量未设时，此处保存的值会在重启后决定业务数据目录。建议填写绝对路径。",
  },
  // 汇率（重启生效）
  { key: "exchangeRateUrl", group: "exchangeRate", label: "汇率接口 URL", type: "text", env: "OWC_EXCHANGE_RATE_URL", defaultValue: null, restartRequired: true, validate: requireHttpUrl },
  { key: "exchangeRateTimeoutMs", group: "exchangeRate", label: "汇率请求超时 (ms)", type: "number", env: "OWC_EXCHANGE_RATE_TIMEOUT_MS", defaultValue: 5_000, restartRequired: true, fromEnv: envNumber },
  { key: "fixedUsdCnyRate", group: "exchangeRate", label: "固定美元汇率", type: "text", env: "OWC_USD_CNY_RATE", defaultValue: null, restartRequired: true, validate: requirePositiveDecimal, description: "填写后跳过在线汇率" },
];

const FIELD_MAP = new Map(FIELDS.map((field) => [field.key, field]));

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
          // 未知键、非法类型与越界值直接忽略，保证旧文件向前兼容，
          // 也避免损坏的 interval 传入 Node timer 后被钳制为 1 ms。
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

  private effectiveValue(field: FieldSpec): SettingValue | null {
    const fromEnv = this.envValue(field);
    if (fromEnv !== undefined) return fromEnv;
    if (field.key in this.overrides) return this.overrides[field.key]!;
    return field.defaultValue;
  }

  effective(): ServerConfig {
    const value = (key: string) => this.effectiveValue(FIELD_MAP.get(key)!);
    const anthropicApiKey = value("anthropicApiKey");
    const anthropicBaseURL = value("anthropicBaseURL");
    const openaiBaseURL = value("openaiBaseURL");
    const openaiApiKey = value("openaiApiKey");
    const exchangeRateUrl = value("exchangeRateUrl");
    const fixedUsdCnyRate = value("fixedUsdCnyRate");
    const provider2BaseURL = value("provider2BaseURL");
    const provider2ApiKey = value("provider2ApiKey");
    const provider2Model = value("provider2Model");
    const searchProvider = value("searchProvider");
    const searchApiKey = value("searchApiKey");
    const searchBaseURL = value("searchBaseURL");
    const jobObjectMemoryMB = value("jobObjectMemoryMB");
    const jobObjectMaxProcesses = value("jobObjectMaxProcesses");
    const sandboxAllowPaths = value("sandboxAllowPaths") as string[];
    const catalogSyncUrl = value("catalogSyncUrl");
    const pricingSyncUrl = value("pricingSyncUrl");
    return {
      host: value("host") as string,
      port: value("port") as number,
      corePath: value("corePath") as string,
      dataDir: value("dataDir") as string,
      coreRequestTimeoutMs: value("coreRequestTimeoutMs") as number,
      gcMaxBytes: value("gcMaxBytes") as number,
      defaultLanguage: value("defaultLanguage") as string,
      defaultCurrency: value("defaultCurrency") as "USD" | "CNY",
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
      ...(typeof anthropicApiKey === "string" || typeof anthropicBaseURL === "string"
        ? {
            anthropic: {
              ...(typeof anthropicApiKey === "string" ? { apiKey: anthropicApiKey } : {}),
              ...(typeof anthropicBaseURL === "string" ? { baseURL: anthropicBaseURL } : {}),
              promptCaching: value("anthropicPromptCaching") as boolean,
            },
          }
        : {}),
      ...(typeof openaiBaseURL === "string"
        ? {
            openai: {
              baseURL: openaiBaseURL,
              ...(typeof openaiApiKey === "string" ? { apiKey: openaiApiKey } : {}),
            },
          }
        : {}),
      // provider2 需要 baseURL 与 model 同时配置才生效；apiKey 可空（本地端点）
      ...(typeof provider2BaseURL === "string" && typeof provider2Model === "string"
        ? {
            provider2: {
              baseURL: provider2BaseURL,
              model: provider2Model,
              ...(typeof provider2ApiKey === "string" ? { apiKey: provider2ApiKey } : {}),
            },
          }
        : {}),
      ...((searchProvider === "brave" || searchProvider === "custom")
        ? {
            search: {
              provider: searchProvider,
              ...(typeof searchApiKey === "string" ? { apiKey: searchApiKey } : {}),
              ...(typeof searchBaseURL === "string" ? { baseURL: searchBaseURL } : {}),
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
          const base = {
            key: field.key,
            label: field.label,
            type: field.type,
            ...(field.options ? { options: field.options } : {}),
            source,
            editable: source !== "env",
            restartRequired: field.restartRequired,
            nullable: field.defaultValue === null,
            ...(field.description ? { description: field.description } : {}),
          };
          if (field.type === "secret") {
            const hasValue = typeof value === "string" && value.length > 0;
            return { ...base, value: null, hasValue, ...(hasValue ? { masked: maskSecret(value as string) } : {}) };
          }
          return { ...base, value, hasValue: value !== null };
        }),
      })),
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
      // 写入与默认值相同的值视为清除覆盖，避免无意义的"已覆盖"残留
      if (value === null || sameSettingValue(value, field.defaultValue)) {
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

  reconcileProviders(): void {
    if (!this.deps) return;
    const config = this.effective();
    this.deps.providers.unregister("anthropic");
    this.deps.providers.unregister("openai");
    if (config.anthropic?.apiKey?.trim()) {
      try {
        this.deps.providers.register(new AnthropicProvider(config.anthropic));
      } catch (error) {
        process.stderr.write(`[settings] Anthropic 接入注册失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (config.openai?.apiKey?.trim()) {
      try {
        this.deps.providers.register(new OpenAICompatibleProvider(config.openai));
      } catch (error) {
        process.stderr.write(`[settings] OpenAI 接入注册失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  /** Names of chat providers whose required connection credentials are configured. */
  configuredProviderNames(): string[] {
    const config = this.effective();
    return [
      ...(config.anthropic?.apiKey?.trim() ? ["anthropic"] : []),
      ...(config.openai?.apiKey?.trim() ? ["openai"] : []),
    ];
  }

  private hotApply(changed: string[]): void {
    if (!this.deps) return;
    if (changed.some((key) => PROVIDER_KEYS.has(key))) {
      this.reconcileProviders();
      // 凭据变更后后台刷新模型目录；无凭据（如刚清除）时不刷新，失败仅记日志
      const config = this.effective();
      if (this.deps.models && (config.anthropic?.apiKey ?? config.openai?.apiKey)) {
        const models = this.deps.models;
        void models
          .refresh({ ...(config.anthropic ? { anthropic: config.anthropic } : {}), ...(config.openai ? { openai: config.openai } : {}) })
          .then((report) => {
            if (report.errors.length > 0) process.stderr.write(`[settings] 模型目录刷新部分失败：${report.errors.join("; ")}\n`);
          })
          .catch((error: unknown) => process.stderr.write(`[settings] 模型目录刷新失败：${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
    if (changed.includes("defaultLanguage")) this.deps.agent.setDefaultLanguage(this.effective().defaultLanguage);
    if (changed.includes("coreRequestTimeoutMs")) this.deps.core.setRequestTimeoutMs(this.effective().coreRequestTimeoutMs);
    if (changed.some((key) => key.startsWith("provider2")) && this.deps.provider2) {
      this.deps.provider2.setConfig(this.effective().provider2);
    }
    if (changed.includes("gcMaxBytes") && this.deps.gc) {
      const gc = this.deps.gc;
      gc.setMaxBytes(this.effective().gcMaxBytes);
      void gc.collect().catch((error: unknown) => process.stderr.write(`[settings] 存储 GC 失败：${error instanceof Error ? error.message : String(error)}\n`));
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
        if (typeof value !== "string" || !field.options?.includes(value)) {
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
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
