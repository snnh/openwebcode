import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "./atomic-file.js";

export type ModelInterfaceType = "anthropic-messages" | "openai-chat-completions";
export type WebCapability = "search" | "fetch";
export type WebProviderType = "jina" | "brave" | "tavily" | "custom";

export interface ModelProviderProfile {
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  apiKey?: string;
  baseURL?: string;
  promptCaching?: boolean;
}

export interface WebProviderProfile {
  id: string;
  provider: WebProviderType;
  capabilities: WebCapability[];
  apiKey?: string;
  searchBaseURL?: string;
  fetchBaseURL?: string;
}

interface ProviderProfilesDocument {
  version: 1;
  updatedAt: string;
  models: ModelProviderProfile[];
  web: WebProviderProfile[];
  activeWeb: { search?: string; fetch?: string };
}

export interface SecretView {
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export type ModelProviderProfileView = Omit<ModelProviderProfile, "apiKey"> & SecretView;
export type WebProviderProfileView = Omit<WebProviderProfile, "apiKey"> & SecretView;

export interface ProviderProfilesView {
  modelProviders: ModelProviderProfileView[];
  webProviders: WebProviderProfileView[];
  activeWeb: { search?: string; fetch?: string };
}

export class ProviderProfilesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProfilesValidationError";
  }
}

function maskSecret(value: string): string {
  return value.length <= 12 ? "••••••" : `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function requireId(value: unknown): string {
  if (typeof value !== "string") throw new ProviderProfilesValidationError("配置名称必须是字符串");
  const id = value.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,63}$/u.test(id)) {
    throw new ProviderProfilesValidationError("配置名称需为 1–64 个字母、数字、空格、点、下划线或连字符");
  }
  return id;
}

function optionalHttpUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ProviderProfilesValidationError(`${label} 必须是字符串`);
  const text = value.trim();
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new ProviderProfilesValidationError(`${label} 不是合法 URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderProfilesValidationError(`${label} 仅支持 http/https`);
  }
  return text;
}

function optionalSecret(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ProviderProfilesValidationError("API Key 必须是字符串");
  return value.trim() || undefined;
}

function uniqueCapabilities(value: unknown): WebCapability[] {
  if (!Array.isArray(value)) throw new ProviderProfilesValidationError("capabilities 必须是数组");
  const result: WebCapability[] = [];
  for (const item of value) {
    if (item !== "search" && item !== "fetch") throw new ProviderProfilesValidationError("联网能力仅支持 search / fetch");
    if (!result.includes(item)) result.push(item);
  }
  if (result.length === 0) throw new ProviderProfilesValidationError("至少声明一项联网能力");
  return result;
}

function capabilitiesFor(provider: WebProviderType, requested?: unknown): WebCapability[] {
  if (provider === "jina") return ["search", "fetch"];
  if (provider === "brave" || provider === "tavily") return ["search"];
  return uniqueCapabilities(requested);
}

function normalizeModel(value: unknown): ModelProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderProfilesValidationError("模型服务商配置必须是对象");
  const raw = value as Record<string, unknown>;
  const id = requireId(raw.id);
  if (raw.interfaceType !== "anthropic-messages" && raw.interfaceType !== "openai-chat-completions") {
    throw new ProviderProfilesValidationError("接口类型必须是 anthropic-messages 或 openai-chat-completions");
  }
  const baseURL = optionalHttpUrl(raw.baseURL, "Base URL");
  const apiKey = optionalSecret(raw.apiKey);
  const enabled = raw.enabled !== false;
  if (enabled && raw.interfaceType === "anthropic-messages" && !apiKey) {
    throw new ProviderProfilesValidationError("Anthropic Messages 接口必须配置 API Key");
  }
  if (raw.promptCaching !== undefined && typeof raw.promptCaching !== "boolean") {
    throw new ProviderProfilesValidationError("promptCaching 必须是布尔值");
  }
  return {
    id,
    enabled,
    interfaceType: raw.interfaceType,
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(raw.interfaceType === "anthropic-messages" ? { promptCaching: raw.promptCaching !== false } : {}),
  };
}

function normalizeWeb(value: unknown): WebProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderProfilesValidationError("联网服务商配置必须是对象");
  const raw = value as Record<string, unknown>;
  const id = requireId(raw.id);
  if (raw.provider !== "jina" && raw.provider !== "brave" && raw.provider !== "tavily" && raw.provider !== "custom") {
    throw new ProviderProfilesValidationError("联网服务类型必须是 jina / brave / tavily / custom");
  }
  const capabilities = capabilitiesFor(raw.provider, raw.capabilities);
  const apiKey = optionalSecret(raw.apiKey);
  const searchBaseURL = optionalHttpUrl(raw.searchBaseURL, "Search Base URL");
  const fetchBaseURL = optionalHttpUrl(raw.fetchBaseURL, "Fetch Base URL");
  if ((raw.provider === "brave" || raw.provider === "tavily") && !apiKey) {
    throw new ProviderProfilesValidationError(`${raw.provider} 必须配置 API Key`);
  }
  if (raw.provider === "custom") {
    if (capabilities.includes("search") && !searchBaseURL) throw new ProviderProfilesValidationError("自定义 search 能力必须配置 Search Base URL");
    if (capabilities.includes("fetch") && (!fetchBaseURL || !fetchBaseURL.includes("{url}"))) {
      throw new ProviderProfilesValidationError("自定义 fetch 能力必须配置包含 {url} 的 Fetch Base URL");
    }
  }
  return {
    id,
    provider: raw.provider,
    capabilities,
    ...(apiKey ? { apiKey } : {}),
    ...(searchBaseURL ? { searchBaseURL } : {}),
    ...(fetchBaseURL ? { fetchBaseURL } : {}),
  };
}

function assertUnique<T extends { id: string }>(items: T[], label: string): void {
  const folded = new Set<string>();
  for (const item of items) {
    const key = item.id.toLocaleLowerCase();
    if (folded.has(key)) throw new ProviderProfilesValidationError(`${label}配置名称重复：${item.id}`);
    folded.add(key);
  }
}

export class ProviderProfilesService {
  private document: ProviderProfilesDocument;
  private listeners = new Set<() => void>();

  private constructor(private readonly filePath: string, document: ProviderProfilesDocument) {
    this.document = document;
  }

  static async load(options: { filePath: string }): Promise<ProviderProfilesService> {
    try {
      const raw = JSON.parse(await readFile(options.filePath, "utf8")) as Record<string, unknown>;
      if (raw.version !== 1 || !Array.isArray(raw.models) || !Array.isArray(raw.web)) {
        throw new ProviderProfilesValidationError("provider-profiles.json 格式无效");
      }
      const models = raw.models.map(normalizeModel);
      const web = raw.web.map(normalizeWeb);
      assertUnique(models, "模型服务商");
      assertUnique(web, "联网服务商");
      const active = raw.activeWeb && typeof raw.activeWeb === "object" ? raw.activeWeb as Record<string, unknown> : {};
      const activeWeb = {
        ...(typeof active.search === "string" && web.some((item) => item.id === active.search && item.capabilities.includes("search")) ? { search: active.search } : {}),
        ...(typeof active.fetch === "string" && web.some((item) => item.id === active.fetch && item.capabilities.includes("fetch")) ? { fetch: active.fetch } : {}),
      };
      return new ProviderProfilesService(options.filePath, {
        version: 1,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
        models,
        web,
        activeWeb,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new ProviderProfilesService(options.filePath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      models: [],
      web: [],
      activeWeb: {},
    });
  }

  view(): ProviderProfilesView {
    const secret = (apiKey: string | undefined): SecretView => ({
      hasApiKey: Boolean(apiKey),
      ...(apiKey ? { maskedApiKey: maskSecret(apiKey) } : {}),
    });
    return {
      modelProviders: this.document.models.map(({ apiKey, ...profile }) => ({ ...profile, ...secret(apiKey) })),
      webProviders: this.document.web.map(({ apiKey, ...profile }) => ({ ...profile, capabilities: [...profile.capabilities], ...secret(apiKey) })),
      activeWeb: { ...this.document.activeWeb },
    };
  }

  modelProfiles(): ModelProviderProfile[] {
    return this.document.models.map((profile) => ({ ...profile }));
  }

  selectedWebProfiles(): { search?: WebProviderProfile; fetch?: WebProviderProfile } {
    const find = (id: string | undefined) => this.document.web.find((item) => item.id === id);
    const search = find(this.document.activeWeb.search);
    const fetch = find(this.document.activeWeb.fetch);
    return { ...(search ? { search } : {}), ...(fetch ? { fetch } : {}) };
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async upsertModel(id: string | undefined, patch: Record<string, unknown>): Promise<ProviderProfilesView> {
    const existing = id ? this.document.models.find((item) => item.id === id) : undefined;
    const merged = { ...(existing ?? {}), ...patch, id: patch.id ?? id ?? `model-${randomUUID().slice(0, 8)}` };
    if (patch.apiKey === undefined && existing?.apiKey) merged.apiKey = existing.apiKey;
    const profile = normalizeModel(merged);
    const next = this.document.models.filter((item) => item.id !== id);
    if (next.some((item) => item.id.toLocaleLowerCase() === profile.id.toLocaleLowerCase())) throw new ProviderProfilesValidationError(`模型服务商配置名称重复：${profile.id}`);
    next.push(profile);
    this.document.models = next;
    await this.changed();
    return this.view();
  }

  async deleteModel(id: string): Promise<ProviderProfilesView> {
    const next = this.document.models.filter((item) => item.id !== id);
    if (next.length === this.document.models.length) throw new ProviderProfilesValidationError(`模型服务商不存在：${id}`);
    this.document.models = next;
    await this.changed();
    return this.view();
  }

  async upsertWeb(id: string | undefined, patch: Record<string, unknown>): Promise<ProviderProfilesView> {
    const existing = id ? this.document.web.find((item) => item.id === id) : undefined;
    const merged = { ...(existing ?? {}), ...patch, id: patch.id ?? id ?? `web-${randomUUID().slice(0, 8)}` };
    if (patch.apiKey === undefined && existing?.apiKey) merged.apiKey = existing.apiKey;
    const profile = normalizeWeb(merged);
    const next = this.document.web.filter((item) => item.id !== id);
    if (next.some((item) => item.id.toLocaleLowerCase() === profile.id.toLocaleLowerCase())) throw new ProviderProfilesValidationError(`联网服务商配置名称重复：${profile.id}`);
    next.push(profile);
    this.document.web = next;
    for (const capability of ["search", "fetch"] as const) {
      if (this.document.activeWeb[capability] === id && !profile.capabilities.includes(capability)) delete this.document.activeWeb[capability];
      else if (this.document.activeWeb[capability] === id) this.document.activeWeb[capability] = profile.id;
    }
    await this.changed();
    return this.view();
  }

  async deleteWeb(id: string): Promise<ProviderProfilesView> {
    const next = this.document.web.filter((item) => item.id !== id);
    if (next.length === this.document.web.length) throw new ProviderProfilesValidationError(`联网服务商不存在：${id}`);
    this.document.web = next;
    if (this.document.activeWeb.search === id) delete this.document.activeWeb.search;
    if (this.document.activeWeb.fetch === id) delete this.document.activeWeb.fetch;
    await this.changed();
    return this.view();
  }

  async selectWeb(capability: WebCapability, id: string | null): Promise<ProviderProfilesView> {
    if (id === null || id === "") delete this.document.activeWeb[capability];
    else {
      const profile = this.document.web.find((item) => item.id === id);
      if (!profile?.capabilities.includes(capability)) throw new ProviderProfilesValidationError(`${id} 未声明 ${capability} 能力`);
      this.document.activeWeb[capability] = id;
    }
    await this.changed();
    return this.view();
  }

  private async changed(): Promise<void> {
    this.document.updatedAt = new Date().toISOString();
    await this.persist();
    for (const listener of this.listeners) listener();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeUtf8Atomically(this.filePath, `${JSON.stringify(this.document, null, 2)}\n`);
  }
}
