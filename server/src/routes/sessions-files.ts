import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { ContextManager } from "../context/context-manager.js";
import { SubAgentLaunchError } from "../agent/agent-runner.js";
import { errorMessage } from "../error-utils.js";
import { RAW_PREVIEW_MIME } from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerSessionFileRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions, agent, events } = dependencies;
  const {
    configuredSessions, restoringSessions,
    acquireManagedWorkspaceUse, acquireManagedWorkspaceExclusive,
    resolveSnapshotBackend, isShellPending, hasRunningBackgroundTask,
    managedSyncingSessions, managedCheckpointingSessions,
  } = ctx;


  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      // 仅在 idle 且尚未配置时配置一次；运行中复用 agent 已配置的状态，避免竞态
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
        configuredSessions.add(session.id);
      }
      return await core.listFiles({ sessionId: request.params.id, path: request.query.path || "." });
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string; offset?: string; limit?: string } }>("/api/sessions/:id/files/content", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "path is required" });
    // 行分页透传 core fs.read（原生支持 offset/limit）；缺省行为不变
    let offset: number | undefined;
    let limit: number | undefined;
    if (request.query.offset !== undefined) {
      offset = Number(request.query.offset);
      if (!Number.isInteger(offset) || offset < 0) return reply.code(400).send({ error: "offset must be a non-negative integer" });
    }
    if (request.query.limit !== undefined) {
      limit = Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 0) return reply.code(400).send({ error: "limit must be a non-negative integer" });
    }
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
        configuredSessions.add(session.id);
      }
      const result = await core.readFile({ sessionId: request.params.id, path: request.query.path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
      return { ...result, revision: createHash("sha256").update(result.content, "utf8").digest("hex") };
    } finally {
      releaseWorkspace();
    }
  });
  // 图片/二进制预览（阶段 2e）：core fs.readBase64 解码直出；扩展名白名单 + nosniff/attachment 防 svg XSS；
  // 老 core 无 fs.readBase64 能力时 501；core 截断时仍返回前缀并以 X-Owc-Truncated 标记。
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files/raw", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const filePath = request.query.path;
    if (!filePath) return reply.code(400).send({ error: "path is required" });
    const extension = (/\.([a-zA-Z0-9]+)$/.exec(filePath.trim())?.[1] ?? "").toLowerCase();
    const mime = RAW_PREVIEW_MIME[extension];
    if (!mime) return reply.code(415).send({ error: `Unsupported preview type: ${extension || "unknown"}` });
    if (typeof core.readFileBase64 !== "function") return reply.code(501).send({ error: "Binary preview is not supported by this core binary" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
        configuredSessions.add(session.id);
      }
      const result = await core.readFileBase64({ sessionId: request.params.id, path: filePath });
      void reply
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", "attachment");
      if (result.truncated) void reply.header("X-Owc-Truncated", "1");
      return reply.send(Buffer.from(result.base64, "base64"));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    } finally {
      releaseWorkspace();
    }
  });
  // @文件引用补全：core.globFiles（模式 *q*），≤20 条；只读免审批（与 /files 同处配置沙盒）
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/sessions/:id/complete-path", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const q = (request.query.q ?? "").trim();
    if (!q) return { matches: [] };
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
        configuredSessions.add(session.id);
      }
      const result = await core.globFiles({ sessionId: request.params.id, path: session.cwd, pattern: `*${q}*` });
      const matches = (result.paths ?? []).slice(0, 20).map((matchPath) => ({ path: matchPath }));
      return { matches };
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string; checkpointId: string } }>("/api/sessions/:id/checkpoints/:checkpointId/diff", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      const backend = await resolveSnapshotBackend(session);
      return { diff: await backend.diff(request.params.checkpointId) };
    } finally {
      releaseWorkspace();
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/snapshot-capability", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    return (await resolveSnapshotBackend(session)).capability();
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await (await resolveSnapshotBackend(session)).list();
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    const label = request.body?.label ?? "Manual checkpoint"; if (typeof label !== "string" || !label.trim()) return reply.code(400).send({ error: "label must be a non-empty string" });
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is already in progress" });
    try {
      const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
      const backend = await resolveSnapshotBackend(session);
      const checkpoint = await backend.create(label, session.messages.length, ledger);
      events.publish({ source: "session", type: "checkpoint.created", sessionId: session.id, payload: checkpoint }); return reply.code(201).send(checkpoint);
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string; checkpointId: string }; Body: { confirm?: boolean; filesOnly?: boolean } }>("/api/sessions/:id/checkpoints/:checkpointId/restore", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    if (request.body?.confirm !== true) return reply.code(400).send({ error: "confirm must be true" });
    // 回退全程持有互斥标记：上方 guard 与此处之间无 await，新 run 无法从缝隙起跑
    restoringSessions.add(session.id);
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseWorkspace) {
      restoringSessions.delete(session.id);
      return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is already in progress" });
    }
    try {
      const backend = await resolveSnapshotBackend(session);
      const checkpoint = (await backend.list()).find((item) => item.id === request.params.checkpointId);
      if (!checkpoint) return reply.code(404).send({ error: "Checkpoint not found" });
      await backend.restore(checkpoint.id);
      if (!request.body?.filesOnly) { await sessions.truncateMessages(session.id, checkpoint.messageCount); await new ContextManager(sessions.contextRoot(session.id)).replaceLedger(checkpoint.ledger); }
      // 回退可能整体重建了工作区（btrfs 换子卷 / zfs 清空重写）：持久 shell 的 cwd 已失效，
      // 回收避免后续命令落进幽灵目录；core 会话配置待下次用到时重建
      await agent.disposePersistentShells?.(session.id).catch(() => undefined);
      configuredSessions.delete(session.id);
      events.publish({ source: "session", type: "checkpoint.restored", sessionId: session.id, payload: { id: checkpoint.id, filesOnly: request.body?.filesOnly === true } }); return checkpoint;
    } finally {
      restoringSessions.delete(session.id);
      releaseWorkspace();
    }
  });
  app.delete<{ Params: { id: string; checkpointId: string } }>("/api/sessions/:id/checkpoints/:checkpointId", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is already in progress" });
    try {
      const backend = await resolveSnapshotBackend(session);
      await backend.delete(request.params.checkpointId);
      events.publish({ source: "session", type: "checkpoint.deleted", sessionId: session.id, payload: { id: request.params.checkpointId } });
      return reply.code(204).send();
    } finally {
      releaseWorkspace();
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; abort it before deletion" });
    }
    if (managedSyncingSessions.has(request.params.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (managedCheckpointingSessions.has(request.params.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
    const detail = await sessions.get(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceExclusive(detail, "teardown");
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is in progress" });
    try {
      // 停止该会话的后台任务
      await dependencies.backgroundTasks?.stopForSession(request.params.id).catch(() => undefined);
      // 回收该会话的持久 shell（提交⑩）；测试里注入的部分 agent 可能未实现该方法
      await agent.disposePersistentShells?.(request.params.id).catch(() => undefined);
      await core.cleanupSession(request.params.id).catch(() => undefined);
      // 释放会话持有的沙盒 core（WSB 虚拟机蒸发）；裸 CoreClient 无 release，为 no-op
      await core.release?.(request.params.id).catch(() => undefined);
      // 托管工作区：必须先成功卸载当前叶子才删 meta。失败时保留会话与镜像，
      // 否则会丢失 chain.json/恢复信息并留下无法定位的挂载盘。
      if (detail.workspace?.mode === "managed" && dependencies.managed) {
        try {
          await dependencies.managed.teardown(detail);
        } catch (error) {
          request.log.error(error, "Managed workspace teardown failed");
          return reply.code(500).send({ error: "Managed workspace teardown failed; the session was retained for recovery" });
        }
      }
      // SessionEnd 钩子：删除前尽力触发（仅通知不阻断；服务停止不做复杂生命周期）
      if (dependencies.hooks) await dependencies.hooks.run("SessionEnd", { sessionId: request.params.id, cwd: detail.cwd });
      // cron 定时任务级联删除（提交⑫）
      await dependencies.cron?.deleteForSession(request.params.id).catch(() => undefined);
      if (!(await sessions.delete(request.params.id))) return reply.code(404).send({ error: "Session not found" });
      // 清理 agent/诊断侧按会话键控的无界小 Map（perf 环形缓冲、MCP 告警签名、提示词覆盖缓存、失败签名）；
      // 测试里注入的部分 agent 可能未实现该方法
      agent.discardSession?.(request.params.id, detail.cwd);
      dependencies.diagnostics?.discardSession(request.params.id);
      return reply.code(204).send();
    } finally {
      releaseWorkspace();
    }
  });

  // 后台任务 REST 路由
  app.get<{ Params: { id: string } }>("/api/sessions/:id/tasks", async (request, reply) => {
    if (!dependencies.backgroundTasks) return reply.code(501).send({ error: "Background tasks are not enabled" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return dependencies.backgroundTasks.listForSession(request.params.id);
  });

  app.get<{ Params: { id: string; taskId: string } }>("/api/sessions/:id/tasks/:taskId", async (request, reply) => {
    if (!dependencies.backgroundTasks) return reply.code(501).send({ error: "Background tasks are not enabled" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const task = dependencies.backgroundTasks.get(request.params.taskId);
    // 校验任务归属：taskId 熵低，不校验即可跨会话读任务输出
    if (!task || task.sessionId !== request.params.id) return reply.code(404).send({ error: "Task not found" });
    return task;
  });

  // 手动启动子代理（WebUI 发起）：校验与并发登记同步完成，运行 detachment，
  // 生命周期经与 spawn_task 相同的 subagent.started/progress/finished 事件跟踪（started 带 manual: true）。
  app.post<{ Params: { id: string }; Body: { prompt?: string; agent?: string } }>("/api/sessions/:id/subagents", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return reply.code(400).send({ error: "prompt must be a non-empty string" });
    if (prompt.length > 4_000) return reply.code(400).send({ error: "prompt must be at most 4000 characters" });
    if (body?.agent !== undefined && typeof body.agent !== "string") return reply.code(400).send({ error: "agent must be a string" });
    try {
      const launched = await agent.launchManualSubagent(request.params.id, { prompt, ...(body?.agent ? { agent: body.agent } : {}) });
      return reply.code(202).send(launched);
    } catch (error) {
      if (error instanceof SubAgentLaunchError) {
        return reply.code(error.code === "busy" ? 429 : 400).send({ error: error.message });
      }
      throw error;
    }
  });

  // 子代理目录：内置 explore/general 在前，随后自定义 markdown 子代理（?cwd= 提供项目目录，否则仅全局）
  app.get<{ Querystring: { cwd?: string } }>("/api/agents", async (request) => {
    const cwd = typeof request.query.cwd === "string" && request.query.cwd.trim() ? request.query.cwd.trim() : undefined;
    return { agents: await agent.listAgentCatalog(cwd) };
  });

  // 子代理转录：runSubAgent 落盘 <contextRoot>/subagents/<taskId>.json，taskId 限定 uuid 防路径穿越
  app.get<{ Params: { id: string; taskId: string } }>("/api/sessions/:id/subagents/:taskId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.taskId)) {
      return reply.code(400).send({ error: "taskId must be a uuid" });
    }
    const transcriptPath = path.join(sessions.contextRoot(request.params.id), "subagents", `${request.params.taskId}.json`);
    let raw: string;
    try {
      raw = await readFile(transcriptPath, "utf8");
    } catch {
      return reply.code(404).send({ error: "Subagent transcript not found" });
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return reply.code(500).send({ error: "Subagent transcript is corrupted" });
    }
  });
}
