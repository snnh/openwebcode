import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { activePathMessages } from "../sessions/session-tree.js";
import { SessionTransferError } from "../sessions/session-transfer.js";
import { renderSessionHtml } from "../export-html.js";
import { renderSessionMarkdown } from "../export-markdown.js";
import { probeSnapshotBackend, probeSnapshotBackendByName, createExecFileRunner } from "../snapshots/probe.js";
import type { ManagedProvisionResult } from "../snapshots/managed-disk.js";
import { ManagedWorkspaceSyncError, type ManagedWorkspaceSyncApplyInput } from "../snapshots/managed-sync.js";
import { ContextManager } from "../context/context-manager.js";
import { resolveSessionPersona } from "../sessions/extension-state.js";
import { errorMessage } from "../error-utils.js";
import type { EffortLevel } from "../context/model-profile.js";
import type { SnapshotMode, SessionMeta, TextContent } from "../sessions/types.js";
import {
  EFFORT_LEVELS, NO_PROVIDER_MESSAGE,
  resolveDefaultProvider, resolveDefaultModel, resolveDefaultSelection, managedSyncFailure,
  type CreateSessionBody, type ManagedWorkspaceSyncBody,
} from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerSessionCoreRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions, agent, events, providers } = dependencies;
  const {
    platform,
    managedSyncingSessions, managedSyncAbortControllers, managedCheckpointingSessions,
    isShellPending, hasRunningBackgroundTask,
    validateSandboxMode, validateSandboxNetwork, validateBindLinks, validateToolNameList, normalizeFallbackModels,
    profileOf,
    acquireManagedWorkspaceUse, acquireManagedWorkspaceExclusive, acquireManagedWorkspaceRun,
  } = ctx;


  /**
   * 新建会话套用全局默认（settings defaultEffort / defaultSnapshotMode）。
   * 力度做能力白名单校验：模型声明不支持的静默跳过（设置是全局偏好，不应阻断创建）；
   * 非法枚举值（如 env 直写）同样静默跳过。
   */
  const applySessionDefaults = async (session: SessionMeta, provider: string, model: string): Promise<SessionMeta> => {
    const config = dependencies.settings?.effective();
    if (!config) return session;
    const patch: { effort?: EffortLevel; snapshotMode?: SnapshotMode } = {};
    if (config.defaultEffort && EFFORT_LEVELS.includes(config.defaultEffort)) {
      const declared = profileOf(model, provider).capabilities.effort;
      if (declared.length === 0 || declared.includes(config.defaultEffort)) patch.effort = config.defaultEffort;
    }
    if (config.defaultSnapshotMode === "manual") patch.snapshotMode = "manual";
    let updated = patch.effort === undefined && patch.snapshotMode === undefined
      ? session
      // updateConfig 的 undefined=清除语义：create 刚落的 toolsAllow/toolsDeny/fallbackModels 需原样透传
      : await sessions.updateConfig(session.id, { provider, model, ...patch, ...(session.toolsAllow ? { toolsAllow: session.toolsAllow } : {}), ...(session.toolsDeny ? { toolsDeny: session.toolsDeny } : {}), ...(session.fallbackModels ? { fallbackModels: session.fallbackModels } : {}) });
    // 快照后端偏好：非 auto 且非托管会话（托管后端由建盘流程预设）时单项探测，
    // 可用则预设跳过探测链；不可用回落自动探测并如实告警，不阻断创建。
    // 本机会话（kind=local）不做快照，跳过预设。
    if (config.snapshotBackend && !updated.workspace && session.kind !== "local") {
      const probed = await probeSnapshotBackendByName(config.snapshotBackend, sessions.contextRoot(session.id), session.cwd, { runner: createExecFileRunner(), platform, core }).catch(() => undefined);
      if (probed) {
        updated = await sessions.updateSnapshotBackend(session.id, config.snapshotBackend);
      } else {
        events.publish({
          source: "server",
          type: "snapshot.backend_fallback",
          sessionId: session.id,
          payload: { preferred: config.snapshotBackend, message: `Snapshot backend "${config.snapshotBackend}" is not available for this workspace; falling back to auto probing` },
        });
      }
    }
    return updated;
  };

  /** 托管工作区创建：能力检测 → 预分配 id 建盘挂载复制 → 落 meta（cwd=挂载点、snapshotBackend 预设）；失败清理半成品 */
  const createManagedSession = async (body: CreateSessionBody, provider: string, model: string, reply: FastifyReply) => {
    const managed = dependencies.managed;
    if (!managed) return reply.code(501).send({ error: "Managed workspace is not configured" });
    const capability = await managed.capability();
    const candidate = capability.backends.find((item) => item.available);
    if (!candidate) {
      const reasons = capability.backends.map((item) => item.detail).filter(Boolean).join("；");
      return reply.code(400).send({ error: `托管工作区不可用${reasons ? `：${reasons}` : "（当前平台不支持）"}` });
    }
    // 源目录必须存在（要复制进镜像）；直接模式不校验 cwd 的行为保持不变
    const origin = await stat(body.cwd).catch(() => undefined);
    if (!origin?.isDirectory()) return reply.code(400).send({ error: `源目录不存在或不是目录：${body.cwd}` });
    const sessionId = randomUUID();
    let provisioned: ManagedProvisionResult;
    try {
      provisioned = await managed.provision({ sessionId, originCwd: body.cwd, backend: candidate.backend });
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
    const workspace = {
      mode: "managed" as const,
      backend: provisioned.backend,
      originCwd: path.resolve(body.cwd),
      image: provisioned.image,
      mountPoint: provisioned.mountPoint,
    };
    try {
      const { workspaceMode: _ignored, ...rest } = body;
      const session = await applySessionDefaults(await sessions.create({
        ...rest,
        provider,
        model,
        id: sessionId,
        cwd: provisioned.mountPoint,
        workspace,
        snapshotBackend: `${provisioned.backend}-chain`,
      }), provider, model);
      events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
      // SessionStart 钩子：仅通知不阻断
      if (dependencies.hooks) await dependencies.hooks.run("SessionStart", { sessionId: session.id, cwd: session.cwd });
      return reply.code(201).send(session);
    } catch (error) {
      await managed.teardown({ id: sessionId, workspace }).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Linux 直接模式创建时的 overlayfs 自动升级：与快照探测链同优先级（btrfs/zfs 命中更优），
   * core 上报 features.overlay.supported 且源目录可挂载时按托管语义创建会话
   * （cwd=merged 视图、源目录只读、需手动同步回源）；任一环节不可用都静默回落直接模式，
   * 由快照探测链懒回落 git-shadow。返回 true 表示已创建并回复，false 表示回落直接模式。
   */
  const tryCreateOverlayfsSession = async (body: CreateSessionBody, provider: string, model: string, reply: FastifyReply): Promise<boolean> => {
    const managed = dependencies.managed;
    if (!managed) return false;
    const sessionId = randomUUID();
    const probed = await probeSnapshotBackend(sessions.contextRoot(sessionId), body.cwd, { runner: createExecFileRunner(), platform, core }).catch(() => undefined);
    if (!probed || probed.name !== "overlayfs") return false;
    // 源目录必须存在（要作 lower 挂载）；直接模式本不校验 cwd，不可挂载即回落
    const origin = await stat(body.cwd).catch(() => undefined);
    if (!origin?.isDirectory()) return false;
    let provisioned: ManagedProvisionResult;
    try {
      provisioned = await managed.provision({ sessionId, originCwd: body.cwd, backend: "overlayfs" });
    } catch {
      return false;
    }
    const workspace = {
      mode: "managed" as const,
      backend: "overlayfs" as const,
      originCwd: path.resolve(body.cwd),
      image: provisioned.image,
      mountPoint: provisioned.mountPoint,
    };
    try {
      const { workspaceMode: _ignored, ...rest } = body;
      const session = await applySessionDefaults(await sessions.create({
        ...rest,
        provider,
        model,
        id: sessionId,
        cwd: provisioned.mountPoint,
        workspace,
        snapshotBackend: "overlayfs",
      }), provider, model);
      events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
      // SessionStart 钩子：仅通知不阻断
      if (dependencies.hooks) await dependencies.hooks.run("SessionStart", { sessionId: session.id, cwd: session.cwd });
      reply.code(201).send(session);
      return true;
    } catch (error) {
      await managed.teardown({ id: sessionId, workspace }).catch(() => undefined);
      throw error;
    }
  };
  app.post<{ Body: CreateSessionBody }>("/api/sessions", async (request, reply) => {
    // 本机会话（kind=local）：cwd 缺省解析为 HOME、沙盒强制 off；与托管工作区互斥
    const isLocal = request.body?.kind === "local";
    if (request.body?.kind !== undefined && request.body.kind !== "local") {
      return reply.code(400).send({ error: 'kind must be "local"' });
    }
    if (!request.body || (!isLocal && (typeof request.body.cwd !== "string" || !request.body.cwd))) {
      return reply.code(400).send({ error: "cwd must be a non-empty string" });
    }
    if (isLocal && request.body.workspaceMode === "managed") {
      return reply.code(400).send({ error: "本机会话不支持托管工作区" });
    }
    const cwd = isLocal ? os.homedir() : request.body.cwd;
    // body 未显式指定 provider/model 时，settings 的 defaultModel 优先于"第一个 profile / 目录首模型"
    const implicitSelection = request.body.provider === undefined && request.body.model === undefined
      ? resolveDefaultSelection(dependencies.settings, providers, dependencies.models)
      : undefined;
    const provider = request.body.provider ?? implicitSelection?.provider ?? resolveDefaultProvider(dependencies.settings, providers);
    if (!provider) {
      return reply.code(400).send({ code: "NO_PROVIDER", message: NO_PROVIDER_MESSAGE, error: NO_PROVIDER_MESSAGE });
    }
    if (!providers.get(provider)) {
      return reply.code(400).send({ error: `Provider ${provider} is not configured` });
    }
    const model = request.body.model ?? implicitSelection?.model ?? resolveDefaultModel(provider, dependencies.models);
    const sandboxModeError = validateSandboxMode(request.body.sandboxMode);
    if (sandboxModeError) return reply.code(400).send({ error: sandboxModeError });
    const networkError = validateSandboxNetwork(request.body.network);
    if (networkError) return reply.code(400).send({ error: networkError });
    // filtered 依赖同 AppContainer 包内 sidecar 代理，wsb 模式下无此形态，组合拒绝
    if (request.body.network === "filtered" && request.body.sandboxMode === "wsb") {
      return reply.code(400).send({ error: "network filtered 不支持 wsb 沙盒模式" });
    }
    const bindLinksError = validateBindLinks(request.body.bindLinks);
    if (bindLinksError) return reply.code(400).send({ error: bindLinksError });
    if (request.body.bindLinks?.length) {
      if (request.body.sandboxMode === "wsb") return reply.code(400).send({ error: "bindLinks 不支持 wsb 沙盒模式（宿主路径在 VM 内无效）" });
      const info = await core.ping().catch(() => undefined);
      if (!info?.features?.bindLink) return reply.code(400).send({ error: "bindLinks 不可用：当前平台 core 未提供 Bind Link 能力（需要 Windows 11 24H2+ 的 bindflt；创建绑定还需以管理员权限运行）" });
    }
    if (request.body.agentMode !== undefined && !["plan", "code", "goal"].includes(request.body.agentMode)) {
      return reply.code(400).send({ error: 'agentMode must be "plan", "code", or "goal"' });
    }
    const toolsAllowError = validateToolNameList(request.body.toolsAllow, "toolsAllow");
    if (toolsAllowError) return reply.code(400).send({ error: toolsAllowError });
    const toolsDenyError = validateToolNameList(request.body.toolsDeny, "toolsDeny");
    if (toolsDenyError) return reply.code(400).send({ error: toolsDenyError });
    // 备选模型链：校验+归一化后回写 body，下游直接/托管/overlayfs 创建路径都带归一化结果
    const fallbackResult = normalizeFallbackModels(request.body.fallbackModels, { provider, model });
    if (fallbackResult.error) return reply.code(400).send({ error: fallbackResult.error });
    if (fallbackResult.entries) request.body.fallbackModels = fallbackResult.entries;
    if (request.body.setupScript !== undefined && typeof request.body.setupScript !== "string") {
      return reply.code(400).send({ error: "setupScript must be a string" });
    }
    if (request.body.workspaceMode !== undefined && request.body.workspaceMode !== "managed") {
      return reply.code(400).send({ error: 'workspaceMode must be "managed"' });
    }
    if (request.body.workspaceMode === "managed") return createManagedSession(request.body, provider, model, reply);
    // Linux 直接模式：core 支持 overlay 时自动升级为 overlayfs 托管会话（见上注释）；本机会话跳过（HOME 不应被挂 overlay 视图）
    if (platform === "linux" && !isLocal && await tryCreateOverlayfsSession(request.body, provider, model, reply)) return;
    const session = await applySessionDefaults(await sessions.create({
      ...request.body,
      provider,
      model,
      cwd,
      ...(isLocal ? { kind: "local" as const, sandboxMode: "off" as const } : {}),
    }), provider, model);
    events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
    // SessionStart 钩子：仅通知不阻断
    if (dependencies.hooks) await dependencies.hooks.run("SessionStart", { sessionId: session.id, cwd: session.cwd });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions", async () => sessions.list());

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/sessions/:id", async (request, reply) => {
    // 0.5.0 Phase 2: paginated session load — only return last N messages
    const limitParam = request.query.limit;
    if (limitParam !== undefined) {
      const limit = Math.max(1, Math.min(500, parseInt(limitParam, 10) || 100));
      const session = await sessions.getTail(request.params.id, limit);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      return session;
    }
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    // 当前生效的 env-sim 人格预设（会话级覆盖优先：extensionState["env-sim"].persona > 旧 persona 字段；扩展未启用/未配置为 null）
    const activePersona = dependencies.extensions ? await dependencies.extensions.activeEnvSimPersona(resolveSessionPersona(session)) : null;
    return { ...session, activePersona };
  });
  /** 会话显示属性：重命名（title ≤120 字符，空串清除覆盖回落派生标题）与置顶（pinned）。 */
  app.patch<{ Params: { id: string }; Body: { title?: string; pinned?: boolean } }>("/api/sessions/:id", async (request, reply) => {
    if (!request.body || (request.body.title === undefined && request.body.pinned === undefined)) {
      return reply.code(400).send({ error: "title or pinned is required" });
    }
    if (request.body.title !== undefined && typeof request.body.title !== "string") {
      return reply.code(400).send({ error: "title must be a string" });
    }
    if (request.body.pinned !== undefined && typeof request.body.pinned !== "boolean") {
      return reply.code(400).send({ error: "pinned must be a boolean" });
    }
    try {
      const updated = await sessions.updateDisplay(request.params.id, request.body);
      events.publish({ source: "session", type: "session.updated", sessionId: updated.id, payload: updated });
      return updated;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  /**
   * 0.5.0 Phase 2: paginated message history — load older messages before a given message ID.
   * Used by the frontend "load more" when scrolling up in long conversations.
   */
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>("/api/sessions/:id/messages", async (request, reply) => {
    const before = request.query.before;
    if (!before) return reply.code(400).send({ error: "before query parameter is required" });
    const limit = Math.max(1, Math.min(500, parseInt(request.query.limit ?? "100", 10) || 100));
    const page = await sessions.getMessagesBefore(request.params.id, before, limit);
    if (!page) return reply.code(404).send({ error: "Session not found" });
    return page;
  });
  /** Read-only tree projection covering ALL nodes (including old branches after checkout/retry). Legacy sessions remain a single derived path. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/timeline", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const activeLeafId = session.activeLeafId ?? session.messages.at(-1)?.id;
    // onActivePath 标记当前活动路径（根→活动叶子）上的节点；条目按时间排序（文件追加序本即时间序，稳定排序保持之）。
    const onPath = new Set(activePathMessages(session.messages, activeLeafId).map((message) => message.id));
    return {
      activeLeafId,
      entries: [...session.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((message) => ({
        id: message.id, parentId: message.parentId,
        runId: message.runId, turnId: message.turnId,
        role: message.role, createdAt: message.createdAt,
        onActivePath: onPath.has(message.id),
      })),
    };
  });
  app.post<{ Params: { id: string }; Body: { cwd?: string; title?: string } }>("/api/sessions/:id/branches", async (request, reply) => {
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session must be idle before cloning" });
    if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd.trim() || (request.body.title !== undefined && typeof request.body.title !== "string")) return reply.code(400).send({ error: "cwd and optional title are required" });
    try {
      const cloned = await sessions.cloneCurrent(request.params.id, request.body.cwd, request.body.title);
      events.publish({ source: "session", type: "branch.cloned", sessionId: cloned.id, payload: { sourceSessionId: request.params.id, mode: "conversation_only" } });
      return reply.code(201).send({ ...cloned, branchMode: "conversation_only" });
    } catch (error) { return reply.code(error instanceof Error && error.message === "Session not found" ? 404 : 409).send({ error: errorMessage(error) }); }
  });

  /**
   * 会话树 checkout：移动活动叶子到任意消息节点（user/assistant/tool 均可）。
   * 仅改 meta（activeLeafId），不动 messages.jsonl；后续 append 以该节点为父，旧分支保留在树中。
   */
  app.post<{ Params: { id: string }; Body: { messageId?: string } }>("/api/sessions/:id/checkout", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const messageId = request.body?.messageId;
    if (typeof messageId !== "string" || !messageId) return reply.code(400).send({ error: "messageId must be a non-empty string" });
    if (!session.messages.some((message) => message.id === messageId)) return reply.code(400).send({ error: "Message not found in this session" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running; wait for it to become idle before checkout" });
    const meta = await sessions.setActiveLeaf(session.id, messageId);
    events.publish({ source: "session", type: "session.updated", sessionId: meta.id, payload: meta });
    return { ok: true, activeLeafId: meta.activeLeafId };
  });

  /**
   * 会话内分支（fork）：同 cwd 新会话，复制根到 messageId（缺省为当前活动叶子）的
   * 活动路径消息与会话配置；不带 ledger/快照/artifact。源会话运行中也允许（只读复制）。
   */
  app.post<{ Params: { id: string }; Body: { messageId?: string } }>("/api/sessions/:id/fork", async (request, reply) => {
    const messageId = request.body?.messageId;
    if (messageId !== undefined && (typeof messageId !== "string" || !messageId)) return reply.code(400).send({ error: "messageId must be a non-empty string" });
    try {
      const forked = await sessions.fork(request.params.id, messageId);
      events.publish({ source: "session", type: "session.created", sessionId: forked.id, payload: forked });
      return reply.code(201).send({ sessionId: forked.id });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message === "Session not found" ? 404 : 400).send({ error: message });
    }
  });

  /**
   * retry：checkout 到目标用户消息的父节点，可选先改写内容，随后按正常消息 start 路径
   * 重新起跑（同一 lease/预算检查/agent.run 与事件流）。旧分支保留在树中。
   */
  app.post<{ Params: { id: string; messageId: string }; Body: { editedContent?: string } }>("/api/sessions/:id/messages/:messageId/retry", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const target = session.messages.find((message) => message.id === request.params.messageId);
    if (!target) return reply.code(400).send({ error: "Message not found in this session" });
    if (target.role !== "user") return reply.code(400).send({ error: "Only user messages can be retried" });
    if (!target.parentId) return reply.code(400).send({ error: "The first user message cannot be retried" });
    const editedContent = request.body?.editedContent;
    if (editedContent !== undefined && typeof editedContent !== "string") return reply.code(400).send({ error: "editedContent must be a string" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running; wait for it to become idle before retrying" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
    if (isShellPending(session.id)) return reply.code(409).send({ error: "shell 命令挂起中，请先回应权限请求或等待其完成" });
    // retry 仅携带文本：原消息的图片/附件块不随 retry 重放（editedContent 同理为纯文本）
    const text = editedContent?.trim()
      ? editedContent
      : target.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
    if (!text.trim()) return reply.code(400).send({ error: "Message has no text content to retry" });
    const automaticSnapshotRequested = (session.snapshotMode ?? "auto") === "auto";
    const workspaceLease = acquireManagedWorkspaceRun(session, automaticSnapshotRequested && !hasRunningBackgroundTask(session.id));
    if (!workspaceLease) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      const budget = await new ContextManager(sessions.contextRoot(session.id)).budgetStatus();
      if (budget.paused) {
        workspaceLease.release();
        return reply.code(409).send({
          error: budget.cost.paused ? "Session cost budget is exhausted or unavailable" : "Session token budget is exhausted",
          budget,
        });
      }
      // checkout 到目标父节点：agent.run 追加的新用户消息以其为父（编辑内容时即为改写后的新消息）
      const meta = await sessions.setActiveLeaf(session.id, target.parentId);
      events.publish({ source: "session", type: "session.updated", sessionId: meta.id, payload: meta });
      void agent.run(session.id, text, {
        managedWorkspace: {
          automaticSnapshotAllowed: workspaceLease.automaticSnapshotAllowed,
          ...(workspaceLease.downgradeAfterAutomaticSnapshot
            ? { downgradeAfterAutomaticSnapshot: workspaceLease.downgradeAfterAutomaticSnapshot }
            : {}),
        },
      }).catch((error: unknown) => {
        // 浏览器已收到 202，详细失败留在 server 日志与 AgentRunner 的 agent.error 事件中。
        request.log.error({ err: error, sessionId: session.id }, "Agent run failed after accepting retry");
      }).finally(workspaceLease.release);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      workspaceLease.release();
      throw error;
    }
  });

  /** 只读预览允许在 agent 运行时调用；apply 会在下方单独拒绝运行中会话。 */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/workspace/sync-preview", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.workspace?.mode !== "managed") return reply.code(400).send({ code: "NOT_MANAGED_WORKSPACE", error: "Session does not use a managed workspace" });
    const managed = dependencies.managed;
    if (!managed) return reply.code(501).send({ error: "Managed workspace is not configured" });
    if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is already in progress for this session" });
    if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await managed.previewSync(session);
    } catch (error) {
      return managedSyncFailure(reply, error);
    } finally {
      releaseWorkspace();
    }
  });

  /** 真实回写必须带确认与刚取得的 fingerprint；不会由关闭/删除会话隐式触发。 */
  app.post<{ Params: { id: string } }>("/api/sessions/:id/workspace/sync-cancel", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.workspace?.mode !== "managed") return reply.code(400).send({ code: "NOT_MANAGED_WORKSPACE", error: "Session does not use a managed workspace" });
    const controller = managedSyncAbortControllers.get(session.id);
    if (!controller) return reply.code(409).send({ error: "Managed workspace sync is not running" });
    controller.abort();
    events.publish({ source: "session", type: "workspace.sync_cancel_requested", sessionId: session.id, payload: {} });
    return reply.code(202).send({ accepted: true });
  });

  app.post<{ Params: { id: string }; Body: ManagedWorkspaceSyncBody }>("/api/sessions/:id/workspace/sync", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.workspace?.mode !== "managed") return reply.code(400).send({ code: "NOT_MANAGED_WORKSPACE", error: "Session does not use a managed workspace" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running; wait for it to become idle before syncing its workspace" });
    if (isShellPending(session.id) || hasRunningBackgroundTask(session.id)) return reply.code(409).send({ error: "A shell or background task is still using this managed workspace" });
    const body = request.body;
    if (!body || body.confirm !== true) return reply.code(400).send({ error: "confirm must be true before syncing a managed workspace" });
    if (typeof body.previewFingerprint !== "string") return reply.code(400).send({ error: "previewFingerprint must be a string from sync-preview" });
    if (body.overwriteConflicts !== undefined && typeof body.overwriteConflicts !== "boolean") return reply.code(400).send({ error: "overwriteConflicts must be a boolean" });
    const managed = dependencies.managed;
    if (!managed) return reply.code(501).send({ error: "Managed workspace is not configured" });
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "sync");
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is in progress" });
    const input: ManagedWorkspaceSyncApplyInput = {
      confirm: true,
      previewFingerprint: body.previewFingerprint,
      ...(body.overwriteConflicts === undefined ? {} : { overwriteConflicts: body.overwriteConflicts }),
    };
    const controller = new AbortController();
    managedSyncAbortControllers.set(session.id, controller);
    events.publish({ source: "session", type: "workspace.sync_started", sessionId: session.id, payload: {} });
    try {
      const result = await managed.applySync(session, input, { signal: controller.signal });
      events.publish({ source: "session", type: "workspace.sync_completed", sessionId: session.id, payload: { applied: result.applied.length, conflicts: result.conflicts.length } });
      return result;
    } catch (error) {
      if (error instanceof ManagedWorkspaceSyncError && error.code === "cancelled") events.publish({ source: "session", type: "workspace.sync_cancelled", sessionId: session.id, payload: {} });
      return managedSyncFailure(reply, error);
    } finally {
      if (managedSyncAbortControllers.get(session.id) === controller) managedSyncAbortControllers.delete(session.id);
      releaseWorkspace();
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/export", async (request, reply) => {
    const jsonl = await sessions.exportJsonl(request.params.id);
    if (jsonl === undefined) return reply.code(404).send({ error: "Session not found" });
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename="session-${request.params.id}.jsonl"`)
      .send(jsonl);
  });

  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>("/api/sessions/:id/export.html", async (request, reply) => {
    const detail = await sessions.get(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Session not found" });
    return reply
      .type("text/html; charset=utf-8")
      .header("content-disposition", `attachment; filename="session-${request.params.id}.html"`)
      .send(renderSessionHtml(detail, request.query.lang === "en" ? "en" : "zh-CN"));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/export.md", async (request, reply) => {
    const detail = await sessions.get(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Session not found" });
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="session-${request.params.id}.md"`)
      .send(renderSessionMarkdown(detail));
  });

  app.post("/api/sessions/import", { bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
    if (typeof request.body !== "string" || request.body.trim() === "") {
      return reply.code(400).send({ error: "JSONL body is required" });
    }
    try {
      const meta = await sessions.importJsonl(request.body);
      events.publish({ source: "session", type: "session.created", sessionId: meta.id, payload: meta });
      return reply.code(201).send(meta);
    } catch (error) {
      if (error instanceof SessionTransferError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}
