import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
export class SettingsValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "SettingsValidationError";
    }
}
const GROUPS = [
    { id: "models", label: "模型接入" },
    { id: "provider2", label: "上下文压缩" },
    { id: "general", label: "语言与货币" },
    { id: "executor", label: "执行器" },
    { id: "service", label: "服务" },
    { id: "exchangeRate", label: "汇率" },
];
const LANGUAGE_OPTIONS = ["zh-CN", "en-US", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "ru-RU"];
const PROVIDER_KEYS = new Set(["anthropicApiKey", "anthropicBaseURL", "anthropicPromptCaching", "openaiBaseURL", "openaiApiKey"]);
function requireHttpUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value));
    }
    catch {
        throw new SettingsValidationError(`${String(value)} 不是合法的 URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SettingsValidationError("URL 仅支持 http/https");
    }
}
function requirePositiveDecimal(value) {
    const text = String(value);
    if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) {
        throw new SettingsValidationError("必须是大于 0 的十进制数");
    }
}
function requireNonEmpty(value) {
    if (String(value).trim() === "")
        throw new SettingsValidationError("不能为空");
}
function requirePort(value) {
    if (typeof value !== "number" || value < 1 || value > 65_535) {
        throw new SettingsValidationError("端口必须是 1-65535 的整数");
    }
}
function envNumber(raw) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}
function envBoolean(raw) {
    if (raw === "true" || raw === "1")
        return true;
    if (raw === "false" || raw === "0")
        return false;
    return undefined;
}
function envCurrency(raw) {
    const normalized = raw.toUpperCase();
    if (normalized === "RMB")
        return "CNY";
    if (normalized === "USD" || normalized === "CNY")
        return normalized;
    return undefined;
}
const FIELDS = [
    // 模型接入（热生效）
    { key: "anthropicApiKey", group: "models", label: "Anthropic API Key", type: "secret", env: "ANTHROPIC_API_KEY", defaultValue: null, restartRequired: false },
    { key: "anthropicBaseURL", group: "models", label: "Anthropic Base URL", type: "text", env: "ANTHROPIC_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "留空使用官方端点" },
    { key: "anthropicPromptCaching", group: "models", label: "Anthropic Prompt Caching", type: "boolean", env: "ANTHROPIC_PROMPT_CACHING", defaultValue: true, restartRequired: false, fromEnv: envBoolean },
    { key: "openaiBaseURL", group: "models", label: "OpenAI 兼容 Base URL", type: "text", env: "OPENAI_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "填写后启用 OpenAI 兼容接入" },
    { key: "openaiApiKey", group: "models", label: "OpenAI API Key", type: "secret", env: "OPENAI_API_KEY", defaultValue: null, restartRequired: false },
    // 上下文压缩 provider2（热生效）：快速廉价的 OpenAI 兼容端点，用于 compact/85% 水位强制压缩
    { key: "provider2BaseURL", group: "provider2", label: "provider2 Base URL", type: "text", env: "OWC_PROVIDER2_BASE_URL", defaultValue: null, restartRequired: false, validate: requireHttpUrl, description: "OpenAI 兼容端点；与模型名同时填写后启用" },
    { key: "provider2ApiKey", group: "provider2", label: "provider2 API Key", type: "secret", env: "OWC_PROVIDER2_API_KEY", defaultValue: null, restartRequired: false },
    { key: "provider2Model", group: "provider2", label: "provider2 模型", type: "text", env: "OWC_PROVIDER2_MODEL", defaultValue: null, restartRequired: false, description: "如 deepseek-chat / claude-haiku-4-5" },
    // 通用（热生效）
    { key: "defaultLanguage", group: "general", label: "默认语言", type: "select", env: "OWC_DEFAULT_LANGUAGE", defaultValue: "zh-CN", restartRequired: false, options: LANGUAGE_OPTIONS },
    { key: "defaultCurrency", group: "general", label: "默认货币", type: "select", env: "OWC_DEFAULT_CURRENCY", defaultValue: "CNY", restartRequired: false, options: ["USD", "CNY"], fromEnv: envCurrency },
    // 执行器
    { key: "corePath", group: "executor", label: "执行器路径", type: "text", env: "OWC_CORE_PATH", defaultValue: "../build/Debug/owc-exec.exe", restartRequired: true, validate: requireNonEmpty },
    { key: "coreRequestTimeoutMs", group: "executor", label: "执行器请求超时 (ms)", type: "number", env: "OWC_CORE_REQUEST_TIMEOUT_MS", defaultValue: 130_000, restartRequired: false, fromEnv: envNumber },
    { key: "gcMaxBytes", group: "service", label: "存储上限 (字节)", type: "number", env: "OWC_GC_MAX_BYTES", defaultValue: 2_147_483_648, restartRequired: false, fromEnv: envNumber, description: "会话 artifacts 全局 LRU 上限，超出后从最旧开始清理" },
    // 服务（重启生效）
    { key: "host", group: "service", label: "监听地址", type: "text", env: "OWC_HOST", defaultValue: "127.0.0.1", restartRequired: true, validate: requireNonEmpty },
    { key: "port", group: "service", label: "监听端口", type: "number", env: "OWC_PORT", defaultValue: 3210, restartRequired: true, fromEnv: envNumber, validate: requirePort },
    { key: "dataDir", group: "service", label: "数据目录", type: "text", env: "OWC_DATA_DIR", defaultValue: "../.openwebcode", restartRequired: true, validate: requireNonEmpty },
    // 汇率（重启生效）
    { key: "exchangeRateUrl", group: "exchangeRate", label: "汇率接口 URL", type: "text", env: "OWC_EXCHANGE_RATE_URL", defaultValue: null, restartRequired: true, validate: requireHttpUrl },
    { key: "exchangeRateTimeoutMs", group: "exchangeRate", label: "汇率请求超时 (ms)", type: "number", env: "OWC_EXCHANGE_RATE_TIMEOUT_MS", defaultValue: 5_000, restartRequired: true, fromEnv: envNumber },
    { key: "fixedUsdCnyRate", group: "exchangeRate", label: "固定美元汇率", type: "text", env: "OWC_USD_CNY_RATE", defaultValue: null, restartRequired: true, validate: requirePositiveDecimal, description: "填写后跳过在线汇率" },
];
const FIELD_MAP = new Map(FIELDS.map((field) => [field.key, field]));
function maskSecret(value) {
    if (value.length <= 12)
        return "••••••";
    return `${value.slice(0, 7)}…${value.slice(-4)}`;
}
export class SettingsService {
    env;
    filePath;
    overrides = {};
    deps;
    constructor(env, filePath) {
        this.env = env;
        this.filePath = filePath;
    }
    static async load(options) {
        const service = new SettingsService(options.env, options.filePath);
        try {
            const raw = await readFile(options.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && parsed.overrides && typeof parsed.overrides === "object") {
                for (const [key, value] of Object.entries(parsed.overrides)) {
                    // 未知键与非法类型直接忽略，保证旧文件向前兼容
                    if (!FIELD_MAP.has(key))
                        continue;
                    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                        service.overrides[key] = value;
                    }
                }
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                process.stderr.write(`[settings] 无法读取 ${options.filePath}，按无覆盖处理：${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        return service;
    }
    bind(deps) {
        this.deps = deps;
    }
    envValue(field) {
        const raw = this.env[field.env];
        if (raw === undefined || raw === "")
            return undefined;
        if (field.fromEnv)
            return field.fromEnv(raw);
        return raw;
    }
    source(field) {
        if (this.envValue(field) !== undefined)
            return "env";
        if (field.key in this.overrides)
            return "file";
        return "default";
    }
    effectiveValue(field) {
        const fromEnv = this.envValue(field);
        if (fromEnv !== undefined)
            return fromEnv;
        if (field.key in this.overrides)
            return this.overrides[field.key];
        return field.defaultValue;
    }
    effective() {
        const value = (key) => this.effectiveValue(FIELD_MAP.get(key));
        const anthropicApiKey = value("anthropicApiKey");
        const anthropicBaseURL = value("anthropicBaseURL");
        const openaiBaseURL = value("openaiBaseURL");
        const openaiApiKey = value("openaiApiKey");
        const exchangeRateUrl = value("exchangeRateUrl");
        const fixedUsdCnyRate = value("fixedUsdCnyRate");
        const provider2BaseURL = value("provider2BaseURL");
        const provider2ApiKey = value("provider2ApiKey");
        const provider2Model = value("provider2Model");
        return {
            host: value("host"),
            port: value("port"),
            corePath: value("corePath"),
            dataDir: value("dataDir"),
            coreRequestTimeoutMs: value("coreRequestTimeoutMs"),
            gcMaxBytes: value("gcMaxBytes"),
            defaultLanguage: value("defaultLanguage"),
            defaultCurrency: value("defaultCurrency"),
            exchangeRate: {
                ...(typeof exchangeRateUrl === "string" ? { url: exchangeRateUrl } : {}),
                timeoutMs: value("exchangeRateTimeoutMs"),
                ...(typeof fixedUsdCnyRate === "string" ? { fixedUsdCnyRate } : {}),
            },
            ...(typeof anthropicApiKey === "string" || typeof anthropicBaseURL === "string"
                ? {
                    anthropic: {
                        ...(typeof anthropicApiKey === "string" ? { apiKey: anthropicApiKey } : {}),
                        ...(typeof anthropicBaseURL === "string" ? { baseURL: anthropicBaseURL } : {}),
                        promptCaching: value("anthropicPromptCaching"),
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
        };
    }
    view() {
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
                        return { ...base, value: null, hasValue, ...(hasValue ? { masked: maskSecret(value) } : {}) };
                    }
                    return { ...base, value, hasValue: value !== null };
                }),
            })),
        };
    }
    async update(patch) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            throw new SettingsValidationError("overrides 必须是对象");
        }
        const entries = Object.entries(patch);
        for (const [key, value] of entries) {
            const field = FIELD_MAP.get(key);
            if (!field)
                throw new SettingsValidationError(`未知配置项：${key}`);
            if (this.envValue(field) !== undefined) {
                throw new SettingsValidationError(`${field.label} 由环境变量 ${field.env} 控制，无法在界面修改`);
            }
            if (value === null)
                continue;
            this.validateValue(field, value);
        }
        const next = { ...this.overrides };
        const changed = [];
        for (const [key, value] of entries) {
            const field = FIELD_MAP.get(key);
            // 写入与默认值相同的值视为清除覆盖，避免无意义的"已覆盖"残留
            if (value === null || value === field.defaultValue) {
                if (key in next) {
                    delete next[key];
                    changed.push(key);
                }
            }
            else if (next[key] !== value) {
                next[key] = value;
                changed.push(key);
            }
        }
        if (changed.length === 0)
            return this.view();
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
    reconcileProviders() {
        if (!this.deps)
            return;
        const config = this.effective();
        this.deps.providers.unregister("anthropic");
        this.deps.providers.unregister("openai");
        if (config.anthropic) {
            try {
                this.deps.providers.register(new AnthropicProvider(config.anthropic));
            }
            catch (error) {
                process.stderr.write(`[settings] Anthropic 接入注册失败：${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        if (config.openai) {
            try {
                this.deps.providers.register(new OpenAICompatibleProvider(config.openai));
            }
            catch (error) {
                process.stderr.write(`[settings] OpenAI 接入注册失败：${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
    }
    hotApply(changed) {
        if (!this.deps)
            return;
        if (changed.some((key) => PROVIDER_KEYS.has(key))) {
            this.reconcileProviders();
            // 凭据变更后后台刷新模型目录；无凭据（如刚清除）时不刷新，失败仅记日志
            const config = this.effective();
            if (this.deps.models && (config.anthropic?.apiKey ?? config.openai?.baseURL)) {
                const models = this.deps.models;
                void models
                    .refresh({ ...(config.anthropic ? { anthropic: config.anthropic } : {}), ...(config.openai ? { openai: config.openai } : {}) })
                    .then((report) => {
                    if (report.errors.length > 0)
                        process.stderr.write(`[settings] 模型目录刷新部分失败：${report.errors.join("; ")}\n`);
                })
                    .catch((error) => process.stderr.write(`[settings] 模型目录刷新失败：${error instanceof Error ? error.message : String(error)}\n`));
            }
        }
        if (changed.includes("defaultLanguage"))
            this.deps.agent.setDefaultLanguage(this.effective().defaultLanguage);
        if (changed.includes("coreRequestTimeoutMs"))
            this.deps.core.setRequestTimeoutMs(this.effective().coreRequestTimeoutMs);
        if (changed.some((key) => key.startsWith("provider2")) && this.deps.provider2) {
            this.deps.provider2.setConfig(this.effective().provider2);
        }
        if (changed.includes("gcMaxBytes") && this.deps.gc) {
            const gc = this.deps.gc;
            gc.setMaxBytes(this.effective().gcMaxBytes);
            void gc.collect().catch((error) => process.stderr.write(`[settings] 存储 GC 失败：${error instanceof Error ? error.message : String(error)}\n`));
        }
        // defaultCurrency 无需主动推送：app 路由经 getPreferences 每次实时读取
    }
    validateValue(field, value) {
        switch (field.type) {
            case "text":
            case "secret":
                if (typeof value !== "string" || value.trim() === "") {
                    throw new SettingsValidationError(`${field.label} 必须是非空字符串（清除请传 null）`);
                }
                break;
            case "number":
                if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
                    throw new SettingsValidationError(`${field.label} 必须是正整数`);
                }
                break;
            case "boolean":
                if (typeof value !== "boolean")
                    throw new SettingsValidationError(`${field.label} 必须是布尔值`);
                break;
            case "select":
                if (typeof value !== "string" || !field.options?.includes(value)) {
                    throw new SettingsValidationError(`${field.label} 必须是 ${field.options?.join(" / ")} 之一`);
                }
                break;
        }
        field.validate?.(value);
    }
    async persist() {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const document = { version: 1, updatedAt: new Date().toISOString(), overrides: this.overrides };
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        await rename(temporary, this.filePath);
    }
}
