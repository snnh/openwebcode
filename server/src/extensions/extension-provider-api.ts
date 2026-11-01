import { getModelProfile, type ModelCapabilities } from "../context/model-profile.js";
import type { CatalogModel, ModelRegistry } from "../context/model-registry.js";
import type { ProviderProfilesService } from "../provider-profiles.js";

export interface ProviderApiDeps {
  providerProfiles?: ProviderProfilesService;
  models?: ModelRegistry;
}

/**
 * providers.upsertProfiles：逐 profile 走 ProviderProfilesService.upsertModel（热生效），
 * 逐 model 走 ModelRegistry.upsertManual（manual 层）。逐项捕获错误、不中途抛——
 * 单项失败（如缺 Key 的 anthropic profile、非法 id）不影响同批其它项。
 */
export async function upsertProviderProfiles(deps: ProviderApiDeps, params: Record<string, unknown>): Promise<{
  profiles: Array<{ id: string; ok: boolean; error?: string }>;
  models: Array<{ id: string; provider?: string; ok: boolean; error?: string }>;
}> {
  const rawProfiles = Array.isArray(params.profiles) ? params.profiles : [];
  const rawModels = Array.isArray(params.models) ? params.models : [];
  const profiles: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const [index, item] of rawProfiles.entries()) {
    const raw = item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : `#${index}`;
    try {
      const service = deps.providerProfiles;
      if (!service) throw new Error("Provider profiles service is not configured");
      if (!raw) throw new Error("模型服务商条目必须是对象");
      // 只提交显式给出的字段：apiKey 缺省时 upsertModel 保留已有 Key（「无凭据更新」语义）。
      const patch: Record<string, unknown> = { id };
      for (const field of ["enabled", "interfaceType", "baseURL", "apiKey", "promptCaching", "includeUsage", "extraBody"] as const) {
        if (raw[field] !== undefined) patch[field] = raw[field];
      }
      await service.upsertModel(id, patch);
      profiles.push({ id, ok: true });
    } catch (error: unknown) {
      profiles.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const models: Array<{ id: string; provider?: string; ok: boolean; error?: string }> = [];
  for (const [index, item] of rawModels.entries()) {
    const raw = item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : `#${index}`;
    const provider = typeof raw?.provider === "string" && raw.provider.trim() ? raw.provider.trim() : undefined;
    try {
      const registry = deps.models;
      if (!registry) throw new Error("Model registry is not configured");
      if (!raw || !provider) throw new Error("模型条目需要 id 与 provider");
      // contextWindow 缺省时按模型元数据库兜底（与 /api/models 的成档口径一致）；
      // capabilities 只声明部分字段时由 registry 的 normalizeCatalogModel 逐字段回落默认。
      const contextWindow = typeof raw.contextWindow === "number" && Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : getModelProfile(id).contextWindow;
      await registry.upsertManual({
        id,
        provider,
        source: "manual",
        contextWindow,
        ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities as ModelCapabilities } : {}),
      } as CatalogModel);
      models.push({ id, provider, ok: true });
    } catch (error: unknown) {
      models.push({ id, ...(provider ? { provider } : {}), ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { profiles, models };
}
