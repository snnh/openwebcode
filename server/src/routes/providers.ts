import type { FastifyInstance, FastifyReply } from "fastify";
import type { EffortLevel, ModelModality, ThinkingMode } from "../context/model-profile.js";
import { lookupModelMetadata } from "../context/model-metadata.js";
import { PricingValidationError, type PricingDocument } from "../cost/pricing-catalog.js";
import { ProviderProfilesValidationError, normalizeModel, type WebCapability } from "../provider-profiles.js";
import { testModelProviderConnection } from "../provider-connection-test.js";
import type { ServerConfig } from "../config.js";
import { errorMessage } from "../error-utils.js";
import type { CatalogModel } from "../context/model-registry.js";
import { EFFORT_LEVELS, MODEL_MODALITIES, THINKING_MODES, serializePricing, syncUrlNotConfigured } from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerProviderRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { providers, pricing, events } = dependencies;
  const { catalog } = ctx;

  app.get("/api/providers", async () => providers.list());
  /** 0.5.0 Phase 2：per-provider 并发与队列深度诊断 */
  app.get("/api/providers/stats", async () => providers.concurrencyStats());
  if (dependencies.providerProfiles) {
    const profiles = dependencies.providerProfiles;
    const profileFailure = (reply: FastifyReply, error: unknown) => reply
      .code(error instanceof ProviderProfilesValidationError ? 400 : 500)
      .send({ error: errorMessage(error) });
    app.get("/api/provider-profiles", async () => profiles.view());
    // 候选配置连接测试：不落盘，直接对表单值做最小化认证请求
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/test", async (request, reply) => {
      try {
        const profile = normalizeModel(request.body ?? {});
        return await testModelProviderConnection(profile);
      } catch (error) { return profileFailure(reply, error); }
    });
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/models", async (request, reply) => {
      try { return await profiles.upsertModel(undefined, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/provider-profiles/models/:id", async (request, reply) => {
      try { return await profiles.upsertModel(request.params.id, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.delete<{ Params: { id: string } }>("/api/provider-profiles/models/:id", async (request, reply) => {
      try { return await profiles.deleteModel(request.params.id); } catch (error) { return profileFailure(reply, error); }
    });
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/web", async (request, reply) => {
      try { return await profiles.upsertWeb(undefined, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/provider-profiles/web/:id", async (request, reply) => {
      try { return await profiles.upsertWeb(request.params.id, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.delete<{ Params: { id: string } }>("/api/provider-profiles/web/:id", async (request, reply) => {
      try { return await profiles.deleteWeb(request.params.id); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { capability: WebCapability }; Body: { id?: string | null } }>("/api/provider-profiles/web-active/:capability", async (request, reply) => {
      if (request.params.capability !== "search" && request.params.capability !== "fetch") return reply.code(400).send({ error: "capability must be search or fetch" });
      try { return await profiles.selectWeb(request.params.capability, request.body?.id ?? null); } catch (error) { return profileFailure(reply, error); }
    });
  }

  app.get("/api/models", async () => catalog().map((profile) => ({
    ...profile,
    ...(pricing.get(profile.provider, profile.id) ? {
      pricing: serializePricing(pricing.get(profile.provider, profile.id)!),
    } : {}),
  })));
  app.get("/api/models/sync-status", async () => dependencies.models?.syncStatus() ?? { count: 0 });
  app.post("/api/models/sync", async () => {
    const url = dependencies.settings?.effective().models.catalogSyncUrl;
    if (!url) return syncUrlNotConfigured("Model catalog");
    const models = dependencies.models;
    if (!models) return syncUrlNotConfigured("Model registry");
    return models.syncCatalogFromUrl(url);
  });
  app.post("/api/models/refresh", async (request, reply) => {
    const models = dependencies.models;
    if (!models) return reply.code(501).send({ error: "Model registry is not configured" });
    const config: Partial<ServerConfig> = dependencies.settings?.effective() ?? {};
    const refreshed = dependencies.providerProfilesRuntime
      ? await dependencies.providerProfilesRuntime.refreshModels()
      : await models.refresh({ providers: [] });
    const url = config.models?.catalogSyncUrl;
    if (!url) return refreshed;
    return { ...refreshed, catalogSync: await models.syncCatalogFromUrl(url) };
  });
  app.put<{ Params: { id: string }; Body: Partial<CatalogModel> & { originalProvider?: string } }>("/api/models/:id", async (request, reply) => {
    const models = dependencies.models;
    if (!models) return reply.code(501).send({ error: "Model registry is not configured" });
    const id = request.params.id;
    const body = request.body ?? {};
    if (body.provider !== undefined && (typeof body.provider !== "string" || !body.provider)) {
      return reply.code(400).send({ error: "provider must be a non-empty string" });
    }
    if (body.displayName !== undefined && typeof body.displayName !== "string") {
      return reply.code(400).send({ error: "displayName must be a string" });
    }
    if (body.capabilities !== undefined) {
      const value = body.capabilities;
      const valid = Boolean(value) && typeof value === "object"
        && Array.isArray(value.modalities) && Array.isArray(value.thinking) && Array.isArray(value.effort)
        && typeof value.imageOutput === "boolean" && typeof value.tools === "boolean"
        && (value.reasoningContent === undefined || typeof value.reasoningContent === "boolean");
      if (!valid) return reply.code(400).send({ error: "capabilities must include modalities/thinking/effort arrays plus imageOutput and tools booleans (reasoningContent optional boolean)" });
      const inRange = value.modalities.every((item) => MODEL_MODALITIES.includes(item as ModelModality))
        && value.thinking.every((item) => THINKING_MODES.includes(item as ThinkingMode))
        && value.effort.every((item) => EFFORT_LEVELS.includes(item as EffortLevel));
      if (!inRange) return reply.code(400).send({ error: "capabilities values out of range (modalities: text/image/video; thinking: adaptive/enabled/disabled; effort: low/medium/high/xhigh/max/ultra)" });
    }
    // maxOutput 已废弃：请求体携带该键时静默忽略（不 400、不透传）。
    if (body.contextWindow !== undefined && (!Number.isSafeInteger(body.contextWindow) || body.contextWindow < 1)) {
      return reply.code(400).send({ error: "contextWindow must be a positive integer" });
    }
    // 已知模型沿用现有档案为底，未知模型经元数据库成档（保守默认）
    const originalProvider = typeof body.originalProvider === "string" ? body.originalProvider : undefined;
    const candidates = models.list().filter((entry) => entry.id === id);
    const known = originalProvider
      ? candidates.find((entry) => entry.provider === originalProvider)
      : body.provider
        ? candidates.find((entry) => entry.provider === body.provider)
        : candidates.length === 1 ? candidates[0] : undefined;
    if (!originalProvider && body.provider === undefined && candidates.length > 1) {
      return reply.code(400).send({ error: "provider is required because this model ID exists under multiple providers" });
    }
    if (!known && body.provider === undefined) {
      return reply.code(400).send({ error: "provider is required for a new model" });
    }
    const metadata = lookupModelMetadata(id);
    const base: CatalogModel = known ?? {
      id,
      provider: "manual",
      source: "api",
      contextWindow: metadata.contextWindow,
      capabilities: metadata.capabilities,
    };
    const displayName = body.displayName ?? base.displayName;
    const model: CatalogModel = {
      ...base,
      provider: body.provider ?? base.provider,
      source: "manual",
      ...(displayName ? { displayName } : {}),
      contextWindow: body.contextWindow ?? base.contextWindow,
      capabilities: body.capabilities ?? base.capabilities,
    };
    if (known?.source === "manual" && known.provider !== model.provider) await models.removeManual(id, known.provider);
    await models.upsertManual(model);
    // Return the registry-normalized representation rather than echoing the
    // request body. This keeps the public capability contract closed (for
    // example, an unsupported videoOutput field is never reflected back).
    return { ...models.get(id, model.provider), source: "manual" as const };
  });
  app.delete<{ Params: { id: string }; Querystring: { provider?: string } }>("/api/models/:id", async (request, reply) => {
    const models = dependencies.models;
    if (!models) return reply.code(501).send({ error: "Model registry is not configured" });
    const provider = request.query.provider;
    const matches = models.list().filter((item) => item.id === request.params.id && item.source === "manual");
    if (!provider && matches.length > 1) return reply.code(400).send({ error: "provider is required because this model ID exists under multiple providers" });
    const selected = provider ?? matches[0]?.provider;
    if (!selected || !models.isManual(request.params.id, selected)) return reply.code(409).send({ error: "Only manual models can be deleted" });
    await models.removeManual(request.params.id, selected);
    return reply.code(204).send();
  });
  app.get("/api/model-pricing", async () => pricing.list());
  app.post("/api/model-pricing/sync", async () => {
    const url = dependencies.settings?.effective().models.pricingSyncUrl;
    if (!url) return syncUrlNotConfigured("Model pricing");
    const result = await pricing.syncFromUrl(url);
    if (result.ok) {
      events.publish({
        source: "server",
        type: "model.pricing_updated",
        payload: { version: 1, updatedAt: result.updatedAt, entries: result.count },
      });
    }
    return result;
  });
  app.put<{ Body: PricingDocument }>("/api/model-pricing", async (request, reply) => {
    try {
      const document = await pricing.replace(request.body);
      events.publish({
        source: "server",
        type: "model.pricing_updated",
        payload: { version: document.version, updatedAt: document.updatedAt, entries: document.entries.length },
      });
      return document;
    } catch (error) {
      return reply.code(error instanceof PricingValidationError ? 400 : 500).send({
        error: error instanceof PricingValidationError
          ? error.message
          : "Failed to persist model pricing",
      });
    }
  });
}
