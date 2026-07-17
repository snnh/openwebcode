import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FALLBACK_METADATA, lookupModelMetadata, type ModelMetadata } from "./model-metadata.js";
import { getModelProfile, listModelProfiles, type ModelProfile } from "./model-profile.js";

export type ModelSource = "builtin" | "api" | "manual";

export interface CatalogModel extends ModelProfile {
  source: ModelSource;
  displayName?: string;
}

export interface ModelCredentials {
  anthropic?: { apiKey?: string; baseURL?: string };
  openai?: { apiKey?: string; baseURL: string };
}

export interface RefreshReport {
  added: number;
  total: number;
  errors: string[];
}

interface RegistryOptions {
  snapshotPath: string;
  manualPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUpdated?: () => void;
}

interface SnapshotFile {
  version: number;
  updatedAt: string;
  models: CatalogModel[];
}

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com";

async function readJsonFile(filePath: string): Promise<SnapshotFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as SnapshotFile;
    if (!parsed || !Array.isArray(parsed.models)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: SnapshotFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, filePath);
}

export class ModelRegistry {
  private apiModels = new Map<string, CatalogModel>();
  private manualModels = new Map<string, CatalogModel>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  private constructor(private readonly options: RegistryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  static async load(options: RegistryOptions): Promise<ModelRegistry> {
    const registry = new ModelRegistry(options);
    const snapshot = await readJsonFile(options.snapshotPath);
    for (const model of snapshot?.models ?? []) {
      if (model && typeof model.id === "string") registry.apiModels.set(model.id, { ...model, source: "api" });
    }
    const manual = await readJsonFile(options.manualPath);
    for (const model of manual?.models ?? []) {
      if (model && typeof model.id === "string") registry.manualModels.set(model.id, { ...model, source: "manual" });
    }
    return registry;
  }

  /** 三向合并：manual > api > builtin；同名 id 高优先级整档覆盖。 */
  list(): CatalogModel[] {
    const merged = new Map<string, CatalogModel>();
    for (const profile of listModelProfiles()) merged.set(profile.id, { ...profile, source: "builtin" });
    for (const [id, model] of this.apiModels) if (!merged.has(id)) merged.set(id, model);
    for (const [id, model] of this.manualModels) merged.set(id, model);
    return [...merged.values()];
  }

  /** 供账本水位线等消费方；未命中时回退静态档案（含 FALLBACK）。 */
  get(id: string): ModelProfile {
    return this.manualModels.get(id) ?? this.apiModels.get(id) ?? getModelProfile(id);
  }

  isManual(id: string): boolean {
    return this.manualModels.has(id);
  }

  /**
   * 从已配置凭据的 provider 拉取模型列表。已成功 provider 的 api 条目整体替换；
   * 失败 provider 保留旧条目并记录 error；manual/builtin 同名 id 跳过（永不覆盖）。
   * 串行执行：设置热应用的后台刷新与手动刷新可能并发，tmp+rename 写同一文件会竞争。
   */
  refresh(credentials: ModelCredentials): Promise<RefreshReport> {
    return this.enqueue(() => this.doRefresh(credentials));
  }

  private async doRefresh(credentials: ModelCredentials): Promise<RefreshReport> {
    const errors: string[] = [];
    let added = 0;
    const tasks: Array<Promise<void>> = [];
    if (credentials.anthropic?.apiKey) {
      tasks.push(
        this.fetchAnthropicModels(credentials.anthropic)
          .then((models) => { added += this.replaceProviderEntries("anthropic", models); })
          .catch((error: unknown) => { errors.push(`anthropic: ${error instanceof Error ? error.message : String(error)}`); }),
      );
    }
    if (credentials.openai?.baseURL) {
      tasks.push(
        this.fetchOpenAIModels(credentials.openai)
          .then((models) => { added += this.replaceProviderEntries("openai", models); })
          .catch((error: unknown) => { errors.push(`openai: ${error instanceof Error ? error.message : String(error)}`); }),
      );
    }
    if (tasks.length === 0) errors.push("未配置任何 provider 凭据");
    await Promise.all(tasks);
    if (added > 0 || errors.length < tasks.length) await this.persist(this.options.snapshotPath, this.apiModels);
    if (added > 0) this.options.onUpdated?.();
    return { added, total: this.apiModels.size, errors };
  }

  async upsertManual(model: CatalogModel): Promise<void> {
    await this.enqueue(async () => {
      this.manualModels.set(model.id, { ...model, source: "manual" });
      await this.persist(this.options.manualPath, this.manualModels);
    });
    this.options.onUpdated?.();
  }

  async removeManual(id: string): Promise<boolean> {
    let removed = false;
    await this.enqueue(async () => {
      removed = this.manualModels.delete(id);
      if (removed) await this.persist(this.options.manualPath, this.manualModels);
    });
    if (removed) this.options.onUpdated?.();
    return removed;
  }

  /** 串行化所有变更操作，避免并发写同一 tmp 文件或交错替换目录。 */
  private chain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 用拉取结果整体替换该 provider 的 api 条目；跳过 manual/builtin 同名 id，返回真正新增的 id 数。 */
  private replaceProviderEntries(provider: string, models: CatalogModel[]): number {
    const builtin = new Set(listModelProfiles().map((profile) => profile.id));
    const known = new Set([...this.apiModels.keys(), ...this.manualModels.keys(), ...builtin]);
    for (const [id, model] of this.apiModels) {
      if (model.provider === provider) this.apiModels.delete(id);
    }
    let added = 0;
    for (const model of models) {
      if (this.manualModels.has(model.id) || builtin.has(model.id)) continue;
      if (!known.has(model.id)) added += 1;
      this.apiModels.set(model.id, model);
    }
    return added;
  }

  private persist(filePath: string, models: Map<string, CatalogModel>): Promise<void> {
    return writeJsonAtomic(filePath, { version: 1, updatedAt: new Date().toISOString(), models: [...models.values()] });
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private toCatalog(id: string, provider: string, displayName?: string): CatalogModel {
    const metadata: ModelMetadata = lookupModelMetadata(id);
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

  private async fetchAnthropicModels(credentials: { apiKey?: string; baseURL?: string }): Promise<CatalogModel[]> {
    const base = (credentials.baseURL ?? ANTHROPIC_MODELS_URL).replace(/\/$/, "");
    const headers = { "x-api-key": credentials.apiKey ?? "", "anthropic-version": "2023-06-01" };
    const models: CatalogModel[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = after ? `?limit=1000&after_id=${encodeURIComponent(after)}` : "?limit=1000";
      const body = (await this.fetchJson(`${base}/v1/models${query}`, headers)) as {
        data?: Array<{ id?: string; display_name?: string }>;
        has_more?: boolean;
        last_id?: string;
      };
      for (const entry of body.data ?? []) {
        if (entry.id) models.push(this.toCatalog(entry.id, "anthropic", entry.display_name));
      }
      if (!body.has_more || !body.last_id) return models;
      after = body.last_id;
    }
    return models;
  }

  private async fetchOpenAIModels(credentials: { apiKey?: string; baseURL: string }): Promise<CatalogModel[]> {
    const base = credentials.baseURL.replace(/\/$/, "");
    const headers: Record<string, string> = credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {};
    const body = (await this.fetchJson(`${base}/models`, headers)) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .filter((entry) => entry.id && isChatModelId(entry.id))
      .map((entry) => this.toCatalog(entry.id!, "openai"));
  }
}

// OpenAI /models 会列出嵌入、语音、绘图等非聊天模型，过滤掉以免污染模型选择器。
// 不排除 "instruct"：兼容端点上 Qwen-Instruct 等聊天模型以此为名。
const NON_CHAT_PATTERN = /whisper|tts|dall[-_]?e|embedding|moderation|babbage|davinci/i;

function isChatModelId(id: string): boolean {
  return !NON_CHAT_PATTERN.test(id);
}

export { FALLBACK_METADATA };
