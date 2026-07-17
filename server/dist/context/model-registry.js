import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FALLBACK_METADATA, lookupModelMetadata } from "./model-metadata.js";
import { getModelProfile, listModelProfiles } from "./model-profile.js";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com";
async function readJsonFile(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        if (!parsed || !Array.isArray(parsed.models))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
async function writeJsonAtomic(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, filePath);
}
export class ModelRegistry {
    options;
    apiModels = new Map();
    manualModels = new Map();
    fetchImpl;
    timeoutMs;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }
    static async load(options) {
        const registry = new ModelRegistry(options);
        const snapshot = await readJsonFile(options.snapshotPath);
        for (const model of snapshot?.models ?? []) {
            if (model && typeof model.id === "string")
                registry.apiModels.set(model.id, { ...model, source: "api" });
        }
        const manual = await readJsonFile(options.manualPath);
        for (const model of manual?.models ?? []) {
            if (model && typeof model.id === "string")
                registry.manualModels.set(model.id, { ...model, source: "manual" });
        }
        return registry;
    }
    /** 三向合并：manual > api > builtin；同名 id 高优先级整档覆盖。 */
    list() {
        const merged = new Map();
        for (const profile of listModelProfiles())
            merged.set(profile.id, { ...profile, source: "builtin" });
        for (const [id, model] of this.apiModels)
            if (!merged.has(id))
                merged.set(id, model);
        for (const [id, model] of this.manualModels)
            merged.set(id, model);
        return [...merged.values()];
    }
    /** 供账本水位线等消费方；未命中时回退静态档案（含 FALLBACK）。 */
    get(id) {
        return this.manualModels.get(id) ?? this.apiModels.get(id) ?? getModelProfile(id);
    }
    isManual(id) {
        return this.manualModels.has(id);
    }
    /**
     * 从已配置凭据的 provider 拉取模型列表。已成功 provider 的 api 条目整体替换；
     * 失败 provider 保留旧条目并记录 error；manual/builtin 同名 id 跳过（永不覆盖）。
     * 串行执行：设置热应用的后台刷新与手动刷新可能并发，tmp+rename 写同一文件会竞争。
     */
    refresh(credentials) {
        return this.enqueue(() => this.doRefresh(credentials));
    }
    async doRefresh(credentials) {
        const errors = [];
        let added = 0;
        const tasks = [];
        if (credentials.anthropic?.apiKey) {
            tasks.push(this.fetchAnthropicModels(credentials.anthropic)
                .then((models) => { added += this.replaceProviderEntries("anthropic", models); })
                .catch((error) => { errors.push(`anthropic: ${error instanceof Error ? error.message : String(error)}`); }));
        }
        if (credentials.openai?.baseURL) {
            tasks.push(this.fetchOpenAIModels(credentials.openai)
                .then((models) => { added += this.replaceProviderEntries("openai", models); })
                .catch((error) => { errors.push(`openai: ${error instanceof Error ? error.message : String(error)}`); }));
        }
        if (tasks.length === 0)
            errors.push("未配置任何 provider 凭据");
        await Promise.all(tasks);
        if (added > 0 || errors.length < tasks.length)
            await this.persist(this.options.snapshotPath, this.apiModels);
        if (added > 0)
            this.options.onUpdated?.();
        return { added, total: this.apiModels.size, errors };
    }
    async upsertManual(model) {
        await this.enqueue(async () => {
            this.manualModels.set(model.id, { ...model, source: "manual" });
            await this.persist(this.options.manualPath, this.manualModels);
        });
        this.options.onUpdated?.();
    }
    async removeManual(id) {
        let removed = false;
        await this.enqueue(async () => {
            removed = this.manualModels.delete(id);
            if (removed)
                await this.persist(this.options.manualPath, this.manualModels);
        });
        if (removed)
            this.options.onUpdated?.();
        return removed;
    }
    /** 串行化所有变更操作，避免并发写同一 tmp 文件或交错替换目录。 */
    chain = Promise.resolve();
    enqueue(task) {
        const run = this.chain.then(task);
        this.chain = run.catch(() => undefined);
        return run;
    }
    /** 用拉取结果整体替换该 provider 的 api 条目；跳过 manual/builtin 同名 id，返回真正新增的 id 数。 */
    replaceProviderEntries(provider, models) {
        const builtin = new Set(listModelProfiles().map((profile) => profile.id));
        const known = new Set([...this.apiModels.keys(), ...this.manualModels.keys(), ...builtin]);
        for (const [id, model] of this.apiModels) {
            if (model.provider === provider)
                this.apiModels.delete(id);
        }
        let added = 0;
        for (const model of models) {
            if (this.manualModels.has(model.id) || builtin.has(model.id))
                continue;
            if (!known.has(model.id))
                added += 1;
            this.apiModels.set(model.id, model);
        }
        return added;
    }
    persist(filePath, models) {
        return writeJsonAtomic(filePath, { version: 1, updatedAt: new Date().toISOString(), models: [...models.values()] });
    }
    async fetchJson(url, headers) {
        const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        return response.json();
    }
    toCatalog(id, provider, displayName) {
        const metadata = lookupModelMetadata(id);
        return {
            id,
            provider,
            ...(displayName && displayName !== id ? { displayName } : {}),
            contextWindow: metadata.contextWindow,
            maxOutput: metadata.maxOutput,
            capabilities: metadata.capabilities,
            source: "api",
        };
    }
    async fetchAnthropicModels(credentials) {
        const base = (credentials.baseURL ?? ANTHROPIC_MODELS_URL).replace(/\/$/, "");
        const headers = { "x-api-key": credentials.apiKey ?? "", "anthropic-version": "2023-06-01" };
        const models = [];
        let after;
        for (let page = 0; page < 20; page += 1) {
            const query = after ? `?limit=1000&after_id=${encodeURIComponent(after)}` : "?limit=1000";
            const body = (await this.fetchJson(`${base}/v1/models${query}`, headers));
            for (const entry of body.data ?? []) {
                if (entry.id)
                    models.push(this.toCatalog(entry.id, "anthropic", entry.display_name));
            }
            if (!body.has_more || !body.last_id)
                return models;
            after = body.last_id;
        }
        return models;
    }
    async fetchOpenAIModels(credentials) {
        const base = credentials.baseURL.replace(/\/$/, "");
        const headers = credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {};
        const body = (await this.fetchJson(`${base}/models`, headers));
        return (body.data ?? [])
            .filter((entry) => entry.id && isChatModelId(entry.id))
            .map((entry) => this.toCatalog(entry.id, "openai"));
    }
}
// OpenAI /models 会列出嵌入、语音、绘图等非聊天模型，过滤掉以免污染模型选择器。
// 不排除 "instruct"：兼容端点上 Qwen-Instruct 等聊天模型以此为名。
const NON_CHAT_PATTERN = /whisper|tts|dall[-_]?e|embedding|moderation|babbage|davinci/i;
function isChatModelId(id) {
    return !NON_CHAT_PATTERN.test(id);
}
export { FALLBACK_METADATA };
