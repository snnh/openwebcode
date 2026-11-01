import type { FastifyInstance } from "fastify";
import { ExtensionRouteError } from "../extensions/extension-manager.js";
import { validateConfigAgainstSchema } from "../extensions/config-schema.js";
import { errorMessage } from "../error-utils.js";
import type { RouteContext } from "./route-context.js";

export function registerExtensionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;

  // ── 目录浏览结束 ────────────────────────────────────────────────────────
  app.get("/api/extensions", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    const list = dependencies.extensions.list();
    // Agent 预设：附加可选预设列表供 UI 平铺卡片/下拉（内置 + 用户目录发现）
    const presets = list.find((item) => item.id === "agent-presets");
    if (presets) presets.availablePresets = (await dependencies.extensions.listAgentPresets()).presets;
    return list;
  });
  app.get("/api/extensions/agent-presets/presets", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    return dependencies.extensions.listAgentPresets();
  });
  app.get("/api/extensions/agent-presets/tools", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    return dependencies.extensions.agentPresetToolCatalog();
  });
  app.get<{ Params: { id: string } }>("/api/extensions/agent-presets/presets/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    const detail = await dependencies.extensions.agentPresetDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Preset not found" });
    return detail;
  });
  app.post("/api/extensions/agent-presets/presets", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    try {
      return reply.code(201).send(await dependencies.extensions.createAgentPreset(request.body));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/extensions/agent-presets/presets/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    try {
      const deleted = await dependencies.extensions.deleteAgentPreset(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "Preset not found" });
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.post<{ Body: { action?: string; id?: string; enabled?: boolean; config?: Record<string, unknown>; path?: string } }>("/api/extensions", async (request, reply) => {
    const extensions = dependencies.extensions;
    if (!extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    const body = request.body ?? {};
    try {
      if (body.action === "install") {
        if (typeof body.path !== "string" || !body.path) return reply.code(400).send({ error: "path is required" });
        return await extensions.install(body.path);
      }
      if (typeof body.id !== "string" || !body.id) return reply.code(400).send({ error: "id is required" });
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
      if (body.config !== undefined && (!body.config || typeof body.config !== "object" || Array.isArray(body.config))) return reply.code(400).send({ error: "config must be an object" });
      // manifest 声明了 configSchema 时做松散校验（类型/枚举/未知键）
      if (body.config !== undefined) {
        const schema = extensions.configSchemaFor(body.id);
        if (schema) {
          const problem = validateConfigAgainstSchema(schema, body.config);
          if (problem) return reply.code(400).send({ error: problem });
        }
      }
      return await extensions.configure(body.id, { ...(body.enabled === undefined ? {} : { enabled: body.enabled }), ...(body.config ? { config: body.config } : {}) });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/extensions/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    try {
      await dependencies.extensions.uninstall(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  /**
   * 扩展私有 HTTP 路由：manifest.routes 声明 + http:route 权限，按路由表精确匹配后经 IPC 转发 Extension Host。
   * 扩展未启用/未运行 → 503；路由未声明 → 404；host 超时 → 504。host 返回 {status, body} 原样响应。
   */
  app.route<{ Params: { id: string; "*": string } }>({
    method: ["GET", "POST", "DELETE"],
    url: "/api/ext/:id/*",
    handler: async (request, reply) => {
      if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
      const rawPath = `/${request.params["*"] ?? ""}`.replace(/\/+$/, "") || "/";
      try {
        const result = await dependencies.extensions.routeHttpRequest(
          request.params.id,
          request.method,
          rawPath,
          (request.query ?? {}) as Record<string, unknown>,
          request.method === "GET" ? undefined : request.body,
        );
        return reply.code(result.status).send(result.body);
      } catch (error) {
        if (error instanceof ExtensionRouteError) return reply.code(error.statusCode).send({ error: error.message });
        return reply.code(500).send({ error: errorMessage(error) });
      }
    },
  });
}
