import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FALLBACK_METADATA, lookupModelMetadata, type ModelMetadata } from "./model-metadata.js";
import {
  getModelProfile,
  listModelProfiles,
  type EffortLevel,
  type ModelCapabilities,
  type ModelModality,
  type ModelProfile,
  type ThinkingMode,
} from "./model-profile.js";

export type ModelSource = "builtin" | "api" | "synced" | "manual";

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

export interface CatalogSyncOptions {
  /** Override the registry fetch implementation, primarily for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
}

export type CatalogSyncResult =
  | { ok: true; count: number; updatedAt: string }
  | { ok: false; error: string };

/** Metadata for the last successfully persisted remote catalog. */
export interface CatalogSyncStatus {
  count: number;
  updatedAt?: string;
}

export interface ModelRegistryOptions {
  snapshotPath: string;
  manualPath: string;
  /** Persistent remote catalog. Defaults to a sibling `models.synced.json` file. */
  syncedSnapshotPath?: string;
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
const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image", "video"];
const THINKING_MODES: readonly ThinkingMode[] = ["adaptive", "enabled", "disabled"];
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    modalities: [...capabilities.modalities],
    thinking: [...capabilities.thinking],
    effort: [...capabilities.effort],
  };
}

function filterKnownValues<T extends string>(value: unknown, fallback: readonly T[], allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is T => typeof item === "string" && (allowed as readonly string[]).includes(item));
}

/** Saved catalogs predate imageOutput; make capabilities total and bounded at the persistence boundary. */
function normalizeCatalogModel(model: CatalogModel, source: ModelSource): CatalogModel {
  const fallback = lookupModelMetadata(model.id).capabilities;
  const raw = model.capabilities as Partial<ModelCapabilities> | undefined;
  return {
    ...model,
    source,
    capabilities: {
      modalities: filterKnownValues(raw?.modalities, fallback.modalities, MODEL_MODALITIES),
      imageOutput: typeof raw?.imageOutput === "boolean" ? raw.imageOutput : fallback.imageOutput,
      thinking: filterKnownValues(raw?.thinking, fallback.thinking, THINKING_MODES),
      effort: filterKnownValues(raw?.effort, fallback.effort, EFFORT_LEVELS),
      tools: typeof raw?.tools === "boolean" ? raw.tools : fallback.tools,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid catalog ${field}`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid catalog ${field}`);
  return value;
}

function strictKnownValues<T extends string>(value: unknown, field: string, fallback: readonly T[], allowed: readonly T[]): T[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`Invalid catalog capabilities.${field}`);
  const normalized: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) {
      throw new Error(`Invalid catalog capabilities.${field}`);
    }
    if (!normalized.includes(item as T)) normalized.push(item as T);
  }
  return normalized;
}

function normalizeSyncedCapabilities(value: unknown, fallback: ModelCapabilities): ModelCapabilities {
  if (value === undefined) return cloneCapabilities(fallback);
  if (!isRecord(value)) throw new Error("Invalid catalog capabilities");
  if (value.imageOutput !== undefined && typeof value.imageOutput !== "boolean") {
    throw new Error("Invalid catalog capabilities.imageOutput");
  }
  if (value.tools !== undefined && typeof value.tools !== "boolean") {
    throw new Error("Invalid catalog capabilities.tools");
  }
  return {
    modalities: strictKnownValues(value.modalities, "modalities", fallback.modalities, MODEL_MODALITIES),
    // Legacy and partial remote catalogs deliberately default to the metadata fallback (currently false).
    imageOutput: typeof value.imageOutput === "boolean" ? value.imageOutput : fallback.imageOutput,
    thinking: strictKnownValues(value.thinking, "thinking", fallback.thinking, THINKING_MODES),
    effort: strictKnownValues(value.effort, "effort", fallback.effort, EFFORT_LEVELS),
    tools: typeof value.tools === "boolean" ? value.tools : fallback.tools,
  };
}

function normalizeSyncedModel(value: unknown): CatalogModel {
  if (!isRecord(value)) throw new Error("Invalid catalog model");
  const id = requiredString(value.id, "model.id");
  const provider = requiredString(value.provider, "model.provider");
  const metadata = lookupModelMetadata(id);
  if (value.displayName !== undefined && typeof value.displayName !== "string") {
    throw new Error("Invalid catalog model.displayName");
  }
  return {
    id,
    provider,
    ...(typeof value.displayName === "string" && value.displayName.trim() !== "" ? { displayName: value.displayName } : {}),
    contextWindow: optionalPositiveInteger(value.contextWindow, "model.contextWindow", metadata.contextWindow),
    maxOutput: optionalPositiveInteger(value.maxOutput, "model.maxOutput", metadata.maxOutput),
    capabilities: normalizeSyncedCapabilities(value.capabilities, metadata.capabilities),
    source: "synced",
  };
}

function normalizeSyncedDocument(value: unknown): { updatedAt: string; models: CatalogModel[] } {
  if (!isRecord(value)) throw new Error("Invalid catalog document");
  if (value.version !== 1) throw new Error("Unsupported catalog version");
  if (!Array.isArray(value.models) || value.models.length === 0) throw new Error("Catalog models must be a non-empty array");
  if (typeof value.updatedAt !== "string" || !ISO_8601_TIMESTAMP.test(value.updatedAt) || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("Invalid catalog updatedAt");
  }

  const models = value.models.map(normalizeSyncedModel);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`Duplicate catalog model id: ${model.id}`);
    ids.add(model.id);
  }
  return { updatedAt: value.updatedAt, models };
}

export class ModelRegistry {
  private apiModels = new Map<string, CatalogModel>();
  private syncedModels = new Map<string, CatalogModel>();
  private syncedUpdatedAt: string | undefined;
  private manualModels = new Map<string, CatalogModel>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly syncedSnapshotPath: string;

  private constructor(private readonly options: ModelRegistryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.syncedSnapshotPath = options.syncedSnapshotPath ?? path.join(path.dirname(options.snapshotPath), "models.synced.json");
  }

  static async load(options: ModelRegistryOptions): Promise<ModelRegistry> {
    const registry = new ModelRegistry(options);
    const snapshot = await readJsonFile(options.snapshotPath);
    for (const model of snapshot?.models ?? []) {
      if (model && typeof model.id === "string") registry.apiModels.set(model.id, normalizeCatalogModel(model, "api"));
    }
    const synced = await readJsonFile(registry.syncedSnapshotPath);
    for (const model of synced?.models ?? []) {
      if (model && typeof model.id === "string") registry.syncedModels.set(model.id, normalizeCatalogModel(model, "synced"));
    }
    if (synced && ISO_8601_TIMESTAMP.test(synced.updatedAt) && !Number.isNaN(Date.parse(synced.updatedAt))) {
      registry.syncedUpdatedAt = synced.updatedAt;
    }
    const manual = await readJsonFile(options.manualPath);
    for (const model of manual?.models ?? []) {
      if (model && typeof model.id === "string") registry.manualModels.set(model.id, normalizeCatalogModel(model, "manual"));
    }
    return registry;
  }

  /**
   * 目录优先级：builtin -> synced -> manual（后者整档覆盖前者）。
   * Provider API 自动发现条目仅用于填补空缺，不能盖过上述持久目录层。
   */
  list(): CatalogModel[] {
    const merged = new Map<string, CatalogModel>();
    for (const profile of listModelProfiles()) merged.set(profile.id, { ...profile, source: "builtin" });
    for (const [id, model] of this.apiModels) if (!merged.has(id)) merged.set(id, model);
    for (const [id, model] of this.syncedModels) merged.set(id, model);
    for (const [id, model] of this.manualModels) merged.set(id, model);
    return [...merged.values()];
  }

  /** 供账本水位线等消费方；未命中时回退静态档案（含 FALLBACK）。 */
  get(id: string): ModelProfile {
    return this.manualModels.get(id) ?? this.syncedModels.get(id) ?? this.apiModels.get(id) ?? getModelProfile(id);
  }

  isManual(id: string): boolean {
    return this.manualModels.has(id);
  }

  /** Status survives restarts because the remote snapshot retains its document timestamp. */
  syncStatus(): CatalogSyncStatus {
    return {
      count: this.syncedModels.size,
      ...(this.syncedUpdatedAt ? { updatedAt: this.syncedUpdatedAt } : {}),
    };
  }

  /**
   * 从已配置凭据的 provider 拉取模型列表。已成功 provider 的 api 条目整体替换；
   * 失败 provider 保留旧条目并记录 error；manual/builtin 同名 id 跳过（永不覆盖）。
   * 串行执行：设置热应用的后台刷新与手动刷新可能并发，tmp+rename 写同一文件会竞争。
   */
  refresh(credentials: ModelCredentials): Promise<RefreshReport> {
    return this.enqueue(() => this.doRefresh(credentials));
  }

  /**
   * Fetch and atomically replace the remote catalog layer. A failed download or validation never
   * changes the in-memory catalog or its previous synced snapshot.
   */
  syncCatalogFromUrl(url: string, opts: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
    return this.enqueue(() => this.doSyncCatalogFromUrl(url, opts));
  }

  private async doSyncCatalogFromUrl(url: string, opts: CatalogSyncOptions): Promise<CatalogSyncResult> {
    try {
      const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 15_000;
      const body = await this.fetchRemoteCatalogJson(url, opts.fetchImpl ?? this.fetchImpl, timeoutMs);
      const document = normalizeSyncedDocument(body);
      const next = new Map(document.models.map((model) => [model.id, model]));

      // Persist first. If the atomic write fails, keep the previous in-memory catalog as well.
      await this.persist(this.syncedSnapshotPath, next, document.updatedAt);
      this.syncedModels = next;
      this.syncedUpdatedAt = document.updatedAt;
      // A notification listener must not turn an already committed snapshot into a reported failure.
      try {
        this.options.onUpdated?.();
      } catch {
        // The next catalog change will notify again; persistence and in-memory state are already valid.
      }
      return { ok: true, count: next.size, updatedAt: document.updatedAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
      this.manualModels.set(model.id, normalizeCatalogModel(model, "manual"));
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
    const known = new Set([...this.apiModels.keys(), ...this.syncedModels.keys(), ...this.manualModels.keys(), ...builtin]);
    for (const [id, model] of this.apiModels) {
      if (model.provider === provider) this.apiModels.delete(id);
    }
    let added = 0;
    for (const model of models) {
      if (this.manualModels.has(model.id) || builtin.has(model.id)) continue;
      if (!known.has(model.id)) added += 1;
      this.apiModels.set(model.id, normalizeCatalogModel(model, "api"));
    }
    return added;
  }

  private persist(filePath: string, models: Map<string, CatalogModel>, updatedAt = new Date().toISOString()): Promise<void> {
    return writeJsonAtomic(filePath, { version: 1, updatedAt, models: [...models.values()] });
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    return this.fetchJsonWith(url, headers, this.fetchImpl, this.timeoutMs);
  }

  private async fetchJsonWith(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private async fetchRemoteCatalogJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
