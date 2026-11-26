import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { ContextManager } from "../context/context-manager.js";
import { SubAgentLaunchError } from "../agent/agent-runner.js";
import { errorMessage } from "../error-utils.js";
import { resolveActiveLeafId } from "../sessions/session-tree.js";
import { checkpointSummary } from "../snapshots/backend.js";
import { acquireSnapshotSessionLock, beginSessionMutation, isSessionMutationActive, isSnapshotSessionLocked, isTerminalOpening } from "../snapshots/session-lock.js";
import { RAW_PREVIEW_MIME } from "./route-context.js";
import type { ManagedSession, RouteContext } from "./route-context.js";

export function registerSessionFileRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions, agent, events } = dependencies;
  const {
    configuredSessions, restoringSessions,
    acquireManagedWorkspaceUse, acquireManagedWorkspaceExclusive,
    resolveSnapshotBackend, isShellPending, hasRunningBackgroundTask,
    managedSyncingSessions, managedCheckpointingSessions, isManagedSession,
  } = ctx;

  /**
   * 检查点写操作的互斥获取：托管闸门（保持托管语义与 409 文案）+ 全后端 per-session
   * 快照锁（B2：非托管会话的托管闸门是 no-op，git-shadow 等后端并发会被 git index.lock
   * 与 checkpoints.json 读改写丢条目）。两处获取之间无 await，不会漏出竞态缝隙；
   * 先取托管闸门，托管会话在「工作区被占用/已在检查点」时仍返回原有 409 文案。
   */
  const acquireCheckpointExclusive = (session: ManagedSession): (() => void) | undefined => {
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseWorkspace) return undefined;
    const releaseSnapshot = acquireSnapshotSessionLock(session.id);
    if (!releaseSnapshot) {
      releaseWorkspace();
      return undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSnapshot();
      releaseWorkspace();
    };
  };

  /** 检查点写操作被互斥挡下时的 409 文案：托管会话保持原文案，非托管会话如实描述。 */
  const checkpointConflictMessage = (session: ManagedSession): string => isManagedSession(session)
    ? "Managed workspace is in use or its checkpoint is already in progress"
    : "A checkpoint operation is already in progress for this session";

  /**
   * create 期间 overlayfs 会复制 upper、镜像盘链会卸载挂载点；restore 则会整体重建/
   * 改写工作区（btrfs/zfs/refs/git-shadow 也一样），因此所有 restore 都要求终端关闭。
   */
  const snapshotNeedsTerminalCheck = (backend: string, action: "create" | "restore"): boolean =>
    action === "restore" || backend === "overlayfs" || backend.endsWith("-chain");
  /** 只有镜像盘链的 create 会卸载挂载点；overlayfs create 只复制 upper，不需要回收 shell。 */
  const snapshotCreateNeedsShellDisposal = (backend: string): boolean => backend.endsWith("-chain");
  const terminalOpen = (sessionId: string): boolean => core.activeTerminalSessions?.().has(sessionId) ?? false;
  /** 含持久 shell 的 PTY 占用：用于关闭 shell 后确认 cwd 不再被旧进程占着。 */
  const ptyOpen = (sessionId: string): boolean => core.activePtySessions?.().has(sessionId) ?? false;
  const workspaceWritePending = (sessionId: string): boolean => agent.isWorkspaceWritePending?.(sessionId) ?? false;
  const terminalConflict = (action: "create" | "restore") => ({
    error: action === "create"
      ? "Close the session terminal before creating a checkpoint（请先关闭该会话的终端后再创建检查点）"
      : "Close the session terminal before restoring a checkpoint（请先关闭该会话的终端后再回滚）",
    code: "snapshot_terminal_open",
  });
  const ptyConflict = {
    error: "A terminal or persistent shell is still using this session; close it before switching the workspace（终端或持久 shell 仍占用工作区，请先关闭后再操作）",
    code: "snapshot_pty_open",
  };
  const historyConflict = {
    error: "Checkpoint history no longer matches this session; create a new checkpoint and retry（检查点历史与当前会话不一致，请新建检查点后重试）",
    code: "checkpoint_history_mismatch",
  };


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
    // 补全输入按字面处理：core 的 glob 只认 `*`（任意串）与 `?`（单字节），不认反斜杠转义。
    // 剥掉元字符后仍是「路径包含 q」的匹配，但 q="*" 不会退化成把整个工作区列一遍。
    const literal = q.replace(/[*?]/g, "");
    if (!literal) return { matches: [] };
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
        configuredSessions.add(session.id);
      }
      const result = await core.globFiles({ sessionId: request.params.id, path: session.cwd, pattern: `*${literal}*` });
      const matches = (result.paths ?? []).slice(0, 20).map((matchPath) => ({ path: matchPath }));
      return { matches };
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string; checkpointId: string } }>("/api/sessions/:id/checkpoints/:checkpointId/diff", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
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
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
    return (await resolveSnapshotBackend(session)).capability();
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      const backend = await resolveSnapshotBackend(session);
      return (await backend.list()).map(checkpointSummary);
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    if (restoringSessions.has(session.id)) return reply.code(409).send({ error: "A checkpoint restore is in progress" });
    if (workspaceWritePending(session.id)) return reply.code(409).send({ error: "A file save is in progress; wait for it to finish before creating a checkpoint" });
    const label = request.body?.label ?? "Manual checkpoint"; if (typeof label !== "string" || !label.trim()) return reply.code(400).send({ error: "label must be a non-empty string" });
    const releaseWorkspace = acquireCheckpointExclusive(session);
    if (!releaseWorkspace) {
      if (isTerminalOpening(session.id)) return reply.code(409).send(terminalConflict("create"));
      if (isSessionMutationActive(session.id)) return reply.code(409).send({ error: "A session operation is in progress" });
      return reply.code(409).send({ error: checkpointConflictMessage(session) });
    }
    try {
      // 锁获取后重读 meta/工作区：等待锁期间配置或 snapshotBackend 可能已切换；
      // 后端探测本身也可能写 meta，不能在终端/回滚窗口里用 guard 前的旧对象做。
      const locked = await sessions.get(session.id);
      if (!locked) return reply.code(404).send({ error: "Session not found" });
      const backend = await resolveSnapshotBackend(locked);
      // 锁获取后再检查，关闭「终端/保存/换层/新 run 之间」的竞态窗口。
      if (restoringSessions.has(session.id)) return reply.code(409).send({ error: "A checkpoint restore is in progress" });
      if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
      if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
      if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
      if (snapshotNeedsTerminalCheck(backend.name, "create") && terminalOpen(session.id)) return reply.code(409).send(terminalConflict("create"));
      if (workspaceWritePending(session.id)) return reply.code(409).send({ error: "A file save is in progress; wait for it to finish before creating a checkpoint" });
      // 托管镜像盘换叶会卸载 mountpoint；持久 shell 的 cwd 还在里面时必须先回收。
      // dispose 内部等待 pty.close；若仍看到 PTY，说明关闭失败或记录已丢失但进程
      // 未退出，此时继续换叶会把 cwd 抽走，直接 409 让用户重试。
      if (snapshotCreateNeedsShellDisposal(backend.name)) {
        try {
          await agent.disposePersistentShells?.(session.id);
        } catch (error) {
          request.log.warn({ err: error, sessionId: session.id }, "persistent shell disposal failed before checkpoint");
          return reply.code(409).send(ptyConflict);
        }
        if (ptyOpen(session.id)) return reply.code(409).send(ptyConflict);
      }
      // 锁内重新读取，避免使用 guard 之后被 checkout/append 改过的消息表。
      const fresh = await sessions.get(session.id);
      if (!fresh) return reply.code(404).send({ error: "Session not found" });
      const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
      const checkpoint = await backend.create(label, fresh.messages.length, ledger, resolveActiveLeafId(fresh.messages, fresh.activeLeafId));
      const summary = checkpointSummary(checkpoint);
      events.publish({ source: "session", type: "checkpoint.created", sessionId: session.id, payload: summary }); return reply.code(201).send(summary);
    } finally {
      releaseWorkspace();
    }
  });
  app.post<{ Params: { id: string; checkpointId: string }; Body: { confirm?: boolean; filesOnly?: boolean } }>("/api/sessions/:id/checkpoints/:checkpointId/restore", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    if (request.body?.confirm !== true) return reply.code(400).send({ error: "confirm must be true" });
    if (workspaceWritePending(session.id)) return reply.code(409).send({ error: "A file save is in progress; wait for it to finish before restoring a checkpoint" });
    // 回退全程持有互斥标记：上方 guard 与此处之间无 await，新 run 无法从缝隙起跑。
    // 标记之后的所有提前返回（解析后端失败/锁冲突/预检 409）都必须经 finally 清理。
    restoringSessions.add(session.id);
    let releaseWorkspace: (() => void) | undefined;
    let restoreStarted = false;
    try {
      releaseWorkspace = acquireCheckpointExclusive(session);
      if (!releaseWorkspace) {
        if (isTerminalOpening(session.id)) return reply.code(409).send(terminalConflict("restore"));
        if (isSessionMutationActive(session.id)) return reply.code(409).send({ error: "A session operation is in progress" });
        return reply.code(409).send({ error: checkpointConflictMessage(session) });
      }
      // 探测/列表/预检/写回都在锁内，避免后端在 guard 之后被切换或并发探测；
      // 等待锁期间 meta/workspace 可能已变，必须用锁内对象探测。
      const locked = await sessions.get(session.id);
      if (!locked) return reply.code(404).send({ error: "Session not found" });
      const backend = await resolveSnapshotBackend(locked);
      const checkpoint = (await backend.list()).find((item) => item.id === request.params.checkpointId);
      if (!checkpoint) return reply.code(404).send({ error: "Checkpoint not found" });
      // 锁内重新读取，预检和写回都使用同一份消息表。
      const fresh = await sessions.get(session.id);
      if (!fresh) return reply.code(404).send({ error: "Session not found" });
      // 回滚前预检：历史条数/活动叶子不合法时不要先动文件。
      if (!request.body?.filesOnly) {
        const retained = fresh.messages.slice(0, checkpoint.messageCount);
        // countMessages 对损坏尾行可能比 messages.length 多 1；这是 truncate 的安全
        // 语义，不能仅因 checkpoint.messageCount 大于有效消息数就拒绝旧快照。
        const currentCount = await sessions.countMessages(session.id);
        if (checkpoint.messageCount > currentCount
          || (checkpoint.activeLeafId !== undefined && !retained.some((message) => message.id === checkpoint.activeLeafId))) {
          return reply.code(409).send(historyConflict);
        }
      }
      // 锁内再检查：normal run 可能在 guard 之后、快照锁之前起跑；restoring 标记
      // 会阻止它走到 agent.run，但已通过的请求仍需在这里拒绝。
      if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
      if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
      if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
      if (snapshotNeedsTerminalCheck(backend.name, "restore") && terminalOpen(session.id)) return reply.code(409).send(terminalConflict("restore"));
      if (workspaceWritePending(session.id)) return reply.code(409).send({ error: "A file save is in progress; wait for it to finish before restoring a checkpoint" });
      // 回退会整体重建（btrfs/zfs/overlayfs/镜像盘）或清理（git-shadow）工作区：
      // 所有后端的持久 shell 都先回收，避免 umount EBUSY 或 cwd 留在旧树。
      try {
        await agent.disposePersistentShells?.(session.id);
      } catch (error) {
        request.log.warn({ err: error, sessionId: session.id }, "persistent shell disposal failed before checkpoint restore");
        return reply.code(409).send(ptyConflict);
      }
      // close 失败时 PTY 仍可能占着 cwd；不要带着旧 shell 去做整卷重建。
      if (ptyOpen(session.id)) return reply.code(409).send(ptyConflict);
      // 从调用后端开始就不能再信任旧 core 配置：即使 restore 半途失败，下一次
      // 用到会话时也必须重新配置 cwd/sandbox。
      restoreStarted = true;
      await backend.restore(checkpoint.id);
      if (!request.body?.filesOnly) {
        await sessions.truncateMessages(session.id, checkpoint.messageCount, checkpoint.activeLeafId);
        await new ContextManager(sessions.contextRoot(session.id)).replaceLedger(checkpoint.ledger);
      }
      events.publish({ source: "session", type: "checkpoint.restored", sessionId: session.id, payload: { id: checkpoint.id, filesOnly: request.body?.filesOnly === true } }); return checkpointSummary(checkpoint);
    } finally {
      // 后端可能已经换过工作区，即使消息/账本写回失败也不能继续复用旧 core 配置。
      if (restoreStarted) configuredSessions.delete(session.id);
      releaseWorkspace?.();
      restoringSessions.delete(session.id);
    }
  });
  app.delete<{ Params: { id: string; checkpointId: string } }>("/api/sessions/:id/checkpoints/:checkpointId", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.kind === "local") return reply.code(400).send({ error: "本机会话不支持快照" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "A shell command is still using this session" });
    if (hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A background task is still using this session" });
    const releaseWorkspace = acquireCheckpointExclusive(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: checkpointConflictMessage(session) });
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
    if (restoringSessions.has(request.params.id) || isSnapshotSessionLocked(request.params.id)) return reply.code(409).send({ error: "A checkpoint operation is in progress" });
    if (isSessionMutationActive(request.params.id)) return reply.code(409).send({ error: "A session operation is in progress" });
    if (workspaceWritePending(request.params.id)) return reply.code(409).send({ error: "A file save is in progress; wait for it to finish before deleting the session" });
    const detail = await sessions.get(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Session not found" });
    const releaseMutation = beginSessionMutation(request.params.id);
    if (!releaseMutation) return reply.code(409).send({ error: "A session operation is in progress" });
    const releaseWorkspace = acquireManagedWorkspaceExclusive(detail, "teardown");
    if (!releaseWorkspace) {
      releaseMutation();
      return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is in progress" });
    }
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
      // 同步丢弃 ContextManager 的静态 view/ledger 缓存（按 contextRoot 键控）：会话已删，
      // 缓存条目再无人命中，不释放即长期驻留。失败不阻断删除流程（与 agent.discardSession 同纪律）。
      try {
        ContextManager.discardSession(sessions.contextRoot(request.params.id));
      } catch {
        // 纯缓存释放失败不阻断删除
      }
      dependencies.diagnostics?.discardSession(request.params.id);
      // 删除后广播：多标签页/多客户端不再残留已删会话
      events.publish({ source: "session", type: "session.deleted", sessionId: request.params.id, payload: {} });
      return reply.code(204).send();
    } finally {
      releaseMutation();
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
  // 生命周期经与 subagent 相同的 subagent.started/progress/finished 事件跟踪（started 带 manual: true）。
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
