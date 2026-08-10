import type { FastifyInstance } from "fastify";
import { ContextManager } from "../context/context-manager.js";
import { errorMessage } from "../error-utils.js";
import type { RouteContext } from "./route-context.js";

export function registerSessionInspectRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { sessions, agent, events } = dependencies;
  const { acquireManagedWorkspaceUse } = ctx;

  // ---- 诊断闭环（0.4.0 Phase 3a）：运行测试 / 读取最近诊断 ----
  // 与 test_runner 工具共用 DiagnosticsService：Core job 执行继承会话权限沙盒，
  // 完整 DiagnosticSet 落 sessions/<id>/diagnostics/<run-id>.json，完成后广播 diagnostics.updated。
  app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/sessions/:id/tests/run", async (request, reply) => {
    const diagnostics = dependencies.diagnostics;
    if (!diagnostics) return reply.code(501).send({ error: "Diagnostics service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const command = typeof request.body?.command === "string" && request.body.command.trim() ? request.body.command.trim() : undefined;
    try {
      const { record, feedback } = await diagnostics.run(session.id, session.cwd, {
        ...(command ? { command } : {}),
        shellBackend: session.shellBackend ?? "default",
      });
      return { record, feedback };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id/diagnostics/latest", async (request, reply) => {
    const diagnostics = dependencies.diagnostics;
    if (!diagnostics) return reply.code(501).send({ error: "Diagnostics service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const latest = await diagnostics.latest(session.id);
    if (!latest) return reply.code(404).send({ error: "No diagnostics recorded for this session" });
    return latest;
  });
  // ---- 性能采样（0.5.0 Phase 2d）：最近 N 次 run 的阶段耗时（脱敏） ----
  app.get<{ Params: { id: string } }>("/api/sessions/:id/perf", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return { records: agent.getPerf(session.id) };
  });
  // ---- Git 集成（0.4.0 Phase 4a）：状态/diff 只读，worktree 生命周期；写操作走托管工作区共享租约，与快照互斥 ----
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/status", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.status(session.id, session.cwd, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string }; Querystring: { staged?: string; base?: string; file?: string } }>("/api/sessions/:id/git/diff", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const staged = request.query.staged === "true" || request.query.staged === "1";
    const base = typeof request.query.base === "string" && request.query.base.trim() ? request.query.base.trim() : undefined;
    if (staged && base) return reply.code(400).send({ error: "staged and base are mutually exclusive" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.diff(session.id, session.cwd, {
        ...(staged ? { staged } : {}),
        ...(base ? { base } : {}),
        ...(typeof request.query.file === "string" && request.query.file.trim() ? { file: request.query.file.trim() } : {}),
      }, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  // ---- stage / unstage / discard（阶段 2a）：body {files: string[]} 非空；discard 含 untracked 必须 force:true ----
  const parseFilesBody = (body: unknown): string[] | undefined => {
    if (!body || typeof body !== "object") return undefined;
    const files = (body as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || file.trim() === "")) return undefined;
    return files as string[];
  };
  app.post<{ Params: { id: string }; Body: { files?: string[] } }>("/api/sessions/:id/git/stage", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const files = parseFilesBody(request.body);
    if (!files) return reply.code(400).send({ error: "files must be a non-empty array of relative paths" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.stage(session.id, session.cwd, files, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string }; Body: { files?: string[] } }>("/api/sessions/:id/git/unstage", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const files = parseFilesBody(request.body);
    if (!files) return reply.code(400).send({ error: "files must be a non-empty array of relative paths" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.unstage(session.id, session.cwd, files, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string }; Body: { files?: string[]; force?: boolean } }>("/api/sessions/:id/git/discard", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const files = parseFilesBody(request.body);
    if (!files) return reply.code(400).send({ error: "files must be a non-empty array of relative paths" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.discard(session.id, session.cwd, files, { force: request.body?.force === true }, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  // 只读提交历史（阶段 2f）；空仓库返回空数组
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/sessions/:id/git/log", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    let limit: number | undefined;
    if (request.query.limit !== undefined) {
      limit = Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ error: "limit must be a positive integer" });
    }
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      const commits = await scm.log(session.id, session.cwd, limit ?? 50, { shellBackend: session.shellBackend ?? "default" });
      return { commits };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/worktrees", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return { worktrees: await scm.listWorktrees(session.id) };
  });
  app.post<{ Params: { id: string }; Body: { name?: string; branch?: string } }>("/api/sessions/:id/git/worktrees", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      const entry = await scm.createWorktree(session.id, session.cwd, {
        ...(typeof request.body?.name === "string" && request.body.name.trim() ? { name: request.body.name.trim() } : {}),
        ...(typeof request.body?.branch === "string" && request.body.branch.trim() ? { branch: request.body.branch.trim() } : {}),
      }, { shellBackend: session.shellBackend ?? "default" });
      return entry;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.delete<{ Params: { id: string; name: string }; Querystring: { force?: string } }>("/api/sessions/:id/git/worktrees/:name", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.removeWorktree(session.id, session.cwd, request.params.name, {
        force: request.query.force === "true" || request.query.force === "1",
      }, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  // 合回显式执行；冲突如实报告文件列表并中止，不做自动解决
  app.post<{ Params: { id: string; name: string }; Body: { strategy?: "merge" | "cherry-pick" } }>("/api/sessions/:id/git/worktrees/:name/merge", async (request, reply) => {
    const scm = dependencies.scm;
    if (!scm) return reply.code(501).send({ error: "SCM service is not enabled" });
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await scm.mergeWorktree(session.id, session.cwd, request.params.name, {
        strategy: request.body?.strategy === "cherry-pick" ? "cherry-pick" : "merge",
      }, { shellBackend: session.shellBackend ?? "default" });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string }; Body: { messageId: string } }>("/api/sessions/:id/context/restore", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; restore context when it is idle" });
    }
    if (!request.body || typeof request.body.messageId !== "string" || !request.body.messageId) {
      return reply.code(400).send({ error: "messageId must be a non-empty string" });
    }
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    try {
      const ledger = await manager.restore(request.body.messageId);
      events.publish({ source: "session", type: "context.restored", sessionId: request.params.id, payload: { messageId: request.body.messageId } });
      return ledger;
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });
  app.post<{ Params: { id: string; messageId: string }; Body: { action?: string } }>("/api/sessions/:id/context/entries/:messageId", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; mutate context when it is idle" });
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    try {
      const action = request.body?.action;
      const ledger = action === "evict"
        ? await manager.evictMessage(session.messages, request.params.messageId)
        : action === "pin"
          ? await manager.setPinned(request.params.messageId, true)
          : action === "unpin"
            ? await manager.setPinned(request.params.messageId, false)
            : undefined;
      if (!ledger) return reply.code(400).send({ error: "action must be evict, pin, or unpin" });
      events.publish({ source: "session", type: "context.entry_updated", sessionId: request.params.id, payload: { messageId: request.params.messageId, action } });
      return ledger;
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });
  app.get<{ Params: { id: string; artifactId: string }; Querystring: { offset?: string; limit?: string } }>("/api/sessions/:id/context/artifacts/:artifactId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const offset = Number(request.query.offset ?? 0);
    const limit = Number(request.query.limit ?? 64_000);
    try {
      return { content: await new ContextManager(sessions.contextRoot(request.params.id)).readArtifact(request.params.artifactId, offset, limit) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { messageId?: string; targetLanguage?: string; glossary?: Record<string, string> } }>("/api/sessions/:id/content-lens/translate", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("content-lens")) return reply.code(409).send({ error: "content-lens extension is disabled" });
    if (!dependencies.contentLens) return reply.code(503).send({ error: "content-lens service is unavailable" });
    if (typeof request.body?.messageId !== "string" || typeof request.body?.targetLanguage !== "string" || !request.body.targetLanguage.trim() || request.body.targetLanguage.length > 64) return reply.code(400).send({ error: "messageId and targetLanguage (1-64 characters) are required" });
    const glossary = request.body.glossary;
    if (glossary !== undefined && (!glossary || typeof glossary !== "object" || Array.isArray(glossary) || Object.keys(glossary).length > 200 || Object.entries(glossary).some(([key, value]) => !key || key.length > 100 || typeof value !== "string" || value.length > 200))) {
      return reply.code(400).send({ error: "glossary must contain at most 200 short string pairs" });
    }
    try { return await dependencies.contentLens.translate(request.params.id, request.body.messageId, request.body.targetLanguage, glossary ?? {}); }
    catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.post<{ Params: { id: string }; Body: { text?: string; targetLanguage?: string } }>("/api/sessions/:id/content-lens/explain", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("content-lens")) return reply.code(409).send({ error: "content-lens extension is disabled" });
    if (!dependencies.contentLens) return reply.code(503).send({ error: "content-lens service is unavailable" });
    if (typeof request.body?.text !== "string" || (request.body.targetLanguage !== undefined && (typeof request.body.targetLanguage !== "string" || !request.body.targetLanguage.trim() || request.body.targetLanguage.length > 64))) return reply.code(400).send({ error: "text and a valid targetLanguage are required" });
    try { return await dependencies.contentLens.explain(request.params.id, request.body.text, request.body.targetLanguage ?? "zh-CN"); }
    catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
}
