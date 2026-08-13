import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SteeringError, WorkspaceWriteDeniedError } from "../agent/agent-runner.js";
import { ContextManager, isPathExcluded } from "../context/context-manager.js";
import { getModelProfile } from "../context/model-profile.js";
import { INIT_COMMAND_PROMPT } from "../agent/prompts/init-prompt.js";
import { CoreRpcError } from "../core-client.js";
import { activePathMessages } from "../sessions/session-tree.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { resolveSessionPersona } from "../sessions/extension-state.js";
import { loadPromptOverride } from "../agent/prompts/prompt-overrides.js";
import { isLoopbackOrLAN } from "../auth-totp.js";
import { errorMessage } from "../error-utils.js";
import {
  IMAGE_MESSAGE_BODY_LIMIT, PDF_UPLOAD_BODY_LIMIT,
  safePdfUploadName, validatePdfUpload, pdfUploadPath, isCanonicalBase64,
  type MessageBody, type PdfUploadBody,
} from "./route-context.js";
import type { RouteContext } from "./route-context.js";
import type { ExtensionManager } from "../extensions/extension-manager.js";

/**
 * 视觉工具官方扩展是否就绪：已启用且配置了视觉模型（`provider/model` 非空）。
 * 就绪时主模型不支持视觉也可以上传图片——扩展的 context.beforeBuild 钩子
 * 会把图片交给视觉模型生成文字描述，再以文本块注入主模型上下文。
 */
function isVisionBridgeActive(extensions: ExtensionManager | undefined): boolean {
  if (!extensions || !extensions.isEnabled("vision-tools")) return false;
  const info = extensions.list().find((item) => item.id === "vision-tools");
  const model = typeof info?.config.model === "string" ? info.config.model.trim() : "";
  return model !== "";
}

export function registerSessionRunRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions, agent, events } = dependencies;
  const {
    listenHost, isAuthorized, bearerAuthorized, totpGateEnabled, totpAuthenticated, originAllowed, hostAllowed,
    configuredSessions, restoringSessions, managedSyncingSessions, managedCheckpointingSessions,
    acquireManagedWorkspaceUse, acquireManagedWorkspaceRun,
    isShellPending, hasRunningBackgroundTask,
  } = ctx;


  // 上下文压缩（§7.4）：/compact（overview）、/compact tools（toolcalls），以及协议 REST 路由
  const runCompact = async (sessionId: string, mode: "toolcalls" | "overview") => {
    // compact-vault 官方扩展启用时，压缩走档案库路径（归档完整上下文 + 目录索引 + 按需召回）；
    // mode 参数不适用（vault 固定归档整理语义），提示词覆盖同样不适用（vault 自带整理提示词）
    const vaultActive = dependencies.vaultService !== undefined && dependencies.extensions?.isEnabled("compact-vault") === true;
    // 开始事件：压缩可能耗时（vault 多次快速模型调用），无论最终 changed 与否都先给 UI 即时反馈
    events.publish({ source: "agent", type: "context.compacting", sessionId, payload: { forced: false, mode: vaultActive ? "vault" : mode } });
    if (dependencies.vaultService && dependencies.extensions?.isEnabled("compact-vault")) {
      const config = dependencies.extensions.list().find((item) => item.id === "compact-vault")?.config ?? {};
      const vaultResult = await dependencies.vaultService.compact(sessionId, {
        ...(Number.isSafeInteger(config.keepTail) ? { keepTail: config.keepTail as number } : {}),
        ...(Number.isSafeInteger(config.chunkSize) ? { chunkSize: config.chunkSize as number } : {}),
      });
      if (vaultResult.changed) {
        events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: vaultResult.mode, uptoIndex: vaultResult.uptoIndex ?? 0, forced: false, ...(vaultResult.createdAt ? { createdAt: vaultResult.createdAt } : {}) } });
      }
      return vaultResult;
    }
    // 压缩提示词优先级：用户覆盖（prompt-overrides 面）> env-sim persona > 内置（内置回退在 Compactor 内）
    let promptOverrides: { overview?: string; toolcalls?: string } | undefined;
    const session = await sessions.get(sessionId);
    if (session) {
      const override = dependencies.dataDir ? await loadPromptOverride(dependencies.dataDir, session.cwd) : undefined;
      const persona = dependencies.extensions
        ? await dependencies.extensions.activeEnvSimPersonaPreset(resolveSessionPersona(session))
        : null;
      const overview = override?.compactOverviewOverride ?? persona?.compactOverviewPrompt;
      const toolcalls = override?.compactToolcallsOverride ?? persona?.compactToolcallsPrompt;
      if (overview || toolcalls) {
        promptOverrides = {
          ...(overview ? { overview } : {}),
          ...(toolcalls ? { toolcalls } : {}),
        };
      }
    }
    const result = await dependencies.compactor!.compact(sessionId, mode, promptOverrides ? { promptOverrides } : undefined);
    if (result.changed) {
      events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: result.mode, uptoIndex: result.uptoIndex ?? 0, forced: false, ...(result.createdAt ? { createdAt: result.createdAt } : {}) } });
    }
    return result;
  };

  const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const MAX_IMAGES_PER_MESSAGE = 4;
  const MAX_IMAGE_BASE64 = 7_000_000; // base64 字符数，约等于 5MB 原始字节
  const MAX_ATTACHMENTS_PER_MESSAGE = 10;
  const isValidImage = (image: unknown): image is { mediaType: string; data: string } => {
    if (!image || typeof image !== "object") return false;
    const record = image as { mediaType?: unknown; data?: unknown };
    return typeof record.mediaType === "string" && IMAGE_MEDIA_TYPES.has(record.mediaType) &&
      typeof record.data === "string" && record.data.length > 0 && record.data.length <= MAX_IMAGE_BASE64 &&
      isCanonicalBase64(record.data);
  };
  app.post<{ Params: { id: string }; Body: { mode?: string } }>("/api/sessions/:id/compact", async (request, reply) => {
    // compact-vault 扩展启用时走档案库压缩，不依赖 Compactor；否则要求压缩器已注入
    const vaultEnabled = dependencies.vaultService !== undefined && dependencies.extensions?.isEnabled("compact-vault") === true;
    if (!dependencies.compactor && !vaultEnabled) return reply.code(503).send({ error: "Compactor not enabled" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running" });
    const mode = request.body?.mode === "toolcalls" ? "toolcalls" : "overview";
    try {
      return await runCompact(request.params.id, mode);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: PdfUploadBody }>(
    "/api/sessions/:id/pdf-upload",
    { bodyLimit: PDF_UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const session = await sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running" });
      if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
      if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
      const name = safePdfUploadName(request.body?.name);
      if (!name) return reply.code(400).send({ error: "name must be a safe PDF filename" });
      const data = validatePdfUpload(request.body?.data);
      if (!data) return reply.code(400).send({ error: "data must be a base64 PDF no larger than 20 MiB" });
      if (!core.writeFileBase64) return reply.code(503).send({ error: "Core binary upload support is unavailable" });
      const releaseWorkspace = acquireManagedWorkspaceUse(session);
      if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
      try {
        // Reuse the same idle-only configuration discipline as file routes.
        // CoreRouter then maps the configured cwd for WSB and translates the
        // relative upload path to the session's sandbox filesystem.
        if (!configuredSessions.has(session.id)) {
          await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
          configuredSessions.add(session.id);
        }
        // An agent may have started while configuration awaited its core RPC.
        // Do not issue a workspace write after that transition.
        if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running" });
        if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
        if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
        const uploadPath = pdfUploadPath(name);
        await core.writeFileBase64({ sessionId: session.id, path: uploadPath, data, createDirs: true });
        return reply.code(201).send({ path: uploadPath });
      } catch (error) {
        request.log.error(error, "PDF upload write failed");
        return reply.code(500).send({ error: "Unable to save PDF upload" });
      } finally {
        releaseWorkspace();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: MessageBody }>(
    "/api/sessions/:id/messages",
    { bodyLimit: IMAGE_MESSAGE_BODY_LIMIT },
    async (request, reply) => {
      if (!request.body || typeof request.body.content !== "string" || !request.body.content) {
        return reply.code(400).send({ error: "content must be a non-empty string" });
      }
      if (request.body.behavior !== undefined && !["start", "steer", "follow_up"].includes(request.body.behavior)) {
        return reply.code(400).send({ error: "behavior must be start, steer, or follow_up" });
      }
      if (request.body.requestId !== undefined && (typeof request.body.requestId !== "string" || !request.body.requestId.trim() || request.body.requestId.length > 200)) {
        return reply.code(400).send({ error: "requestId must be a non-empty string of at most 200 characters" });
      }
      const session = await sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
      if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
      // shell 快捷前缀挂起中（权限审批/执行）：避免消息落盘与 shell 落盘竞态，要求先 respond
      if (isShellPending(request.params.id)) {
        return reply.code(409).send({ error: "shell 命令挂起中，请先回应权限请求或等待其完成" });
      }
      const images = request.body.images;
      if (images !== undefined) {
        if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE || images.some((image) => !isValidImage(image))) {
          return reply.code(400).send({ error: `images 需为至多 ${MAX_IMAGES_PER_MESSAGE} 张 png/jpeg/webp/gif（base64），每张不超过 5MB` });
        }
        if (images.length > 0) {
          const profile = dependencies.models?.get(session.model) ?? getModelProfile(session.model);
          // 视觉工具扩展启用且已配置视觉模型时，主模型不支持视觉也放行：
          // context.beforeBuild 钩子会把图片替换为视觉模型的文字描述再注入主模型。
          const visionBridgeActive = isVisionBridgeActive(dependencies.extensions);
          if (!profile.capabilities.modalities.includes("image") && !visionBridgeActive) {
            return reply.code(400).send({ error: `模型 ${session.model} 不支持图片输入` });
          }
          if (agent.isRunning(request.params.id)) {
            return reply.code(409).send({ error: "会话运行中，带图消息请等待完成或中断后再发送" });
          }
        }
      }
      // @文件引用：基础结构验证 + 运行中拒绝（与 images 同等对待，避免附件被 steering 路径吞掉）
      const attachments = request.body.attachments;
      if (attachments !== undefined) {
        if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS_PER_MESSAGE ||
          attachments.some((item) => !item || typeof item.path !== "string" || !item.path.trim())) {
          return reply.code(400).send({ error: `attachments 需为至多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个 { path: string }` });
        }
        if (attachments.length > 0 && agent.isRunning(request.params.id)) {
          return reply.code(409).send({ error: "会话运行中，带附件消息请等待完成或中断后再发送" });
        }
      }
      const clearCommand = request.body.content.match(/^\/clear\s*$/i);
      if (clearCommand) {
        if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "会话运行中，请先等待完成或中断后再清空上下文" });
        // 边界双空间记录：
        // - uptoIndex 用活动路径长度（与 agent 视图/compactor 同口径：清空全部活动路径消息，
        //   分支/retry 的离路径消息不参与计数，clear 后新追加的消息不受越界边界影响）；
        // - uptoMessageId 为最后一条活动路径消息 id，供 buildView 与前端分隔线在自己持有的
        //   数组（活动路径或全量 JSONL）里精确定位——仅靠活动路径长度换算全量下标会因
        //   离路径消息穿插而错位（分隔线提早插入、REST 视图残留尾部消息）。
        const activePath = activePathMessages(session.messages, session.activeLeafId);
        const uptoIndex = activePath.length;
        const uptoMessageId = activePath.at(-1)?.id;
        const ledger = await new ContextManager(sessions.contextRoot(request.params.id)).markCleared(uptoIndex, uptoMessageId);
        const at = ledger.cleared!.at;
        events.publish({ source: "agent", type: "context.cleared", sessionId: request.params.id, payload: { uptoIndex, at, ...(uptoMessageId ? { uptoMessageId } : {}) } });
        return reply.code(200).send({ accepted: true, cleared: true, uptoIndex, at, ...(uptoMessageId ? { uptoMessageId } : {}) });
      }
      const compactCommand = request.body.content.match(/^\/compact(?:\s+(tools?|toolcalls))?\s*$/i);
      if (compactCommand) {
        // 与 POST /compact 同口径：compact-vault 启用时不依赖 Compactor
        const slashVaultEnabled = dependencies.vaultService !== undefined && dependencies.extensions?.isEnabled("compact-vault") === true;
        if (!dependencies.compactor && !slashVaultEnabled) return reply.code(503).send({ error: "压缩器未启用" });
        if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "会话运行中，请先等待完成或中断后再压缩" });
        try {
          const result = await runCompact(request.params.id, compactCommand[1] ? "toolcalls" : "overview");
          return reply.code(200).send({ accepted: true, compacted: result.changed, result });
        } catch (error) {
          return reply.code(400).send({ error: errorMessage(error) });
        }
      }
      // /init：展开为探查提示词（用户覆盖 > env-sim persona > 内置）后继续走正常 agent.run() 路径（写 AGENTS.md 经权限链与快照）
      if (/^\/init\s*$/i.test(request.body.content)) {
        if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "会话运行中，请先等待完成或中断后再初始化" });
        const override = dependencies.dataDir ? await loadPromptOverride(dependencies.dataDir, session.cwd) : undefined;
        const persona = dependencies.extensions
          ? await dependencies.extensions.activeEnvSimPersonaPreset(resolveSessionPersona(session))
          : null;
        request.body.content = override?.initOverride ?? persona?.initPrompt ?? INIT_COMMAND_PROMPT;
      }
      if (agent.isRunning(request.params.id)) {
        try {
          if (request.body.behavior === "start") return reply.code(409).send({ error: "Session is already running; use steer or follow_up" });
          const queued = request.body.behavior === "follow_up"
            ? await agent.enqueueFollowUp(request.params.id, request.body.content, request.body.requestId)
            : await agent.enqueueSteering(request.params.id, request.body.content, request.body.requestId);
          return reply.code(202).send({ accepted: true, queued: true, behavior: request.body.behavior ?? "steer", ...queued });
        } catch (error) {
          const code = error instanceof SteeringError
            ? (error.code === "full" ? 429 : error.code === "too_long" ? 413 : 409)
            : 409;
          return reply.code(code).send({ error: errorMessage(error) });
        }
      }
      if (request.body.behavior === "steer" || request.body.behavior === "follow_up") {
        return reply.code(409).send({ error: `${request.body.behavior} requires a running session` });
      }
      const automaticSnapshotRequested = (session.snapshotMode ?? "auto") === "auto";
      // Background task state is checked again inside AgentRunner. This early
      // check merely avoids reserving an exclusive lease when it is already
      // known that this turn cannot make an automatic checkpoint.
      const workspaceLease = acquireManagedWorkspaceRun(
        session,
        automaticSnapshotRequested && !hasRunningBackgroundTask(session.id),
      );
      if (!workspaceLease) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
      try {
        const budget = await new ContextManager(sessions.contextRoot(request.params.id)).budgetStatus();
        if (budget.paused) {
          workspaceLease.release();
          return reply.code(409).send({
            error: budget.cost.paused ? "Session cost budget is exhausted or unavailable" : "Session token budget is exhausted",
            budget,
          });
        }
        // @文件引用：appendMessage 前对每个 path 调 core.readFile（受沙盒），过 boundToolResult（大文件截断 + artifact）；
        // 越界/不可读降级为错误块而非抛错炸掉整个请求；组装为前置 text 块 `[Attachment <path>]\n<内容>`
        const attachmentBlocks: Array<{ text: string }> = [];
        if (attachments && attachments.length > 0) {
          if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
            await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd) });
            configuredSessions.add(session.id);
          }
          const contextRoot = sessions.contextRoot(request.params.id);
          const contextExcludes = session.contextExcludes ?? [];
          for (const item of attachments) {
            const attachmentPath = item.path.trim();
            if (isPathExcluded(attachmentPath, contextExcludes)) {
              attachmentBlocks.push({ text: `[Attachment ${attachmentPath}]
已被会话上下文排除清单跳过（排除只影响上下文组装，不是安全边界；工具仍可按权限读取该文件）` });
              continue;
            }
            try {
              const result = await core.readFile({ sessionId: request.params.id, path: attachmentPath });
              const bounded = await boundToolResult(contextRoot, "read_file", result.content);
              attachmentBlocks.push({ text: `[Attachment ${attachmentPath}]\n${bounded.content}` });
            } catch (error) {
              const reason = errorMessage(error);
              attachmentBlocks.push({ text: `[Attachment ${attachmentPath}]\n错误：路径越界或不可读（${reason}）` });
            }
          }
        }
        // 与回退互斥的最终关卡：检查后同步进入 agent.run（其首行即占位 running），
        // 与 restore 路由的 guard 块原子交错——要么这里 409，要么 restore 端看到 running 拒绝
        if (restoringSessions.has(request.params.id)) {
          workspaceLease.release();
          return reply.code(409).send({ error: "Session checkpoint restore is in progress" });
        }
        void agent.run(request.params.id, request.body.content, {
          ...(images?.length ? { images } : {}),
          ...(attachmentBlocks.length ? { attachments: attachmentBlocks } : {}),
          managedWorkspace: {
            automaticSnapshotAllowed: workspaceLease.automaticSnapshotAllowed,
            ...(workspaceLease.downgradeAfterAutomaticSnapshot
              ? { downgradeAfterAutomaticSnapshot: workspaceLease.downgradeAfterAutomaticSnapshot }
              : {}),
          },
        }).catch((error: unknown) => {
          // The browser already received 202, so keep the detailed failure in
          // the server log as well as AgentRunner's agent.error event.
          request.log.error({ err: error, sessionId: request.params.id }, "Agent run failed after accepting message");
        }).finally(workspaceLease.release);
        return reply.code(202).send({ accepted: true });
      } catch (error) {
        workspaceLease.release();
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/todos", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return agent.listTodos(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/run", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const run = await agent.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "No run has been recorded for this session" });
    return run;
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/permissions", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    // 待确认权限走 REST 可恢复：刷新或重连后 WS 补发可能已越过 permission.request 事件
    return agent.listPendingPermissions(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { requestId: string; decision: "allow" | "allow_always" | "deny"; reason?: string } }>("/api/sessions/:id/permissions/respond", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body.requestId !== "string" || !["allow", "allow_always", "deny"].includes(body.decision) || (body.reason !== undefined && typeof body.reason !== "string")) {
      return reply.code(400).send({ error: "requestId, decision allow|allow_always|deny, and optional reason are required" });
    }
    const complete = await agent.preparePermissionResponse(request.params.id, body.requestId, body.decision, body.reason);
    if (!complete) return reply.code(404).send({ error: "Permission request not found" });
    let resumed = false;
    const resume = (): void => {
      if (resumed) return;
      resumed = true;
      complete();
    };
    // 先把批准结果交付给浏览器，再恢复可能耗时的工具执行；连接提前关闭时也执行已确认的决定。
    reply.raw.once("finish", resume);
    reply.raw.once("close", resume);
    return reply.send({ accepted: true });
  });

  // C2 `!` shell 快捷前缀：走与 bash 工具相同的权限链 + core.run，但不进 agent run 循环（isRunning 全程 false）。
  // 落盘 user (`!cmd`) + tool_result 一对；权限挂起复用 permission.request/respond 机制。
  app.post<{ Params: { id: string }; Body: { cmd?: string } }>(
    "/api/sessions/:id/shell",
    async (request, reply) => {
      const session = await sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const cmd = request.body?.cmd;
      if (typeof cmd !== "string" || cmd.trim() === "") return reply.code(400).send({ error: "cmd must be a non-empty string" });
      if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session agent is running; wait for it to finish before running a shell command" });
      if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
      if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
      if (isShellPending(request.params.id)) return reply.code(409).send({ error: "A shell command is already pending; respond to its permission request first" });
      const releaseWorkspace = acquireManagedWorkspaceUse(session);
      if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
      void agent.runShell(request.params.id, cmd).catch(() => undefined).finally(releaseWorkspace);
      return reply.code(202).send({ accepted: true });
    },
  );

  // 编辑器保存（0.5.0 Phase 1a）：复用 write_file 工具同一权限链（plan 只读门禁/审批事件），不落盘消息。
  // 与 shell 不同步返回结果：前端需要保存成功/失败的明确反馈；审批挂起期间请求保持打开，respond 后完成。
  app.put<{ Params: { id: string }; Body: { path?: string; content?: string; expectedRevision?: string } }>(
    "/api/sessions/:id/files/content",
    async (request, reply) => {
      const session = await sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const path = request.body?.path;
      const content = request.body?.content;
      const expectedRevision = request.body?.expectedRevision;
      if (typeof path !== "string" || path.trim() === "" || typeof content !== "string" || typeof expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(expectedRevision)) return reply.code(400).send({ error: "path, content, and a valid expectedRevision are required" });
      if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session agent is running; wait for it to finish before saving files" });
      if (managedSyncingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
      if (managedCheckpointingSessions.has(session.id)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
      if (isShellPending(request.params.id)) return reply.code(409).send({ error: "A shell command is already pending; respond to its permission request first" });
      const releaseWorkspace = acquireManagedWorkspaceUse(session);
      if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
      try {
        await agent.writeWorkspaceFile(request.params.id, path, content, expectedRevision);
        return { ok: true, revision: createHash("sha256").update(content, "utf8").digest("hex") };
      } catch (error) {
        if (error instanceof WorkspaceWriteDeniedError) return reply.code(403).send({ error: error.message });
        if (error instanceof CoreRpcError && error.code === -32004) return reply.code(409).send({ error: error.message });
        return reply.code(400).send({ error: errorMessage(error) });
      } finally {
        releaseWorkspace();
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/steering", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return agent.listSteering(request.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id/queue", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return agent.listQueue(request.params.id);
  });
  app.patch<{ Params: { id: string; itemId: string }; Body: { content?: string; kind?: "steer" | "follow_up" } }>("/api/sessions/:id/queue/:itemId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || (body.content === undefined && body.kind === undefined) || (body.content !== undefined && (typeof body.content !== "string" || !body.content)) || (body.kind !== undefined && !["steer", "follow_up"].includes(body.kind))) return reply.code(400).send({ error: "content and/or kind steer|follow_up are required" });
    const item = await agent.updateQueue(request.params.id, request.params.itemId, body);
    if (!item) return reply.code(409).send({ error: "Queue item is missing or already consuming" });
    return item;
  });
  app.delete<{ Params: { id: string; itemId: string } }>("/api/sessions/:id/queue/:itemId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!(await agent.removeQueue(request.params.id, request.params.itemId))) return reply.code(409).send({ error: "Queue item is missing or already consuming" });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id/interactions", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return agent.listInteractions(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { runId?: string; toolCallId?: string; kind?: string; title?: string; prompt?: string; options?: Array<{ id?: string; label?: string; description?: string }>; allowOther?: boolean } }>("/api/sessions/:id/interactions", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body.runId !== "string" || typeof body.title !== "string" || typeof body.prompt !== "string" || !["confirm", "single_select", "multi_select", "text"].includes(body.kind ?? "") || (body.toolCallId !== undefined && typeof body.toolCallId !== "string") || (body.allowOther !== undefined && typeof body.allowOther !== "boolean") || (body.options !== undefined && (!Array.isArray(body.options) || body.options.some((option) => !option || typeof option.id !== "string" || typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string"))))) return reply.code(400).send({ error: "runId, kind, title, prompt, and valid optional options are required" });
    if (["single_select", "multi_select"].includes(body.kind!) && (!body.options || body.options.length === 0)) return reply.code(400).send({ error: "select interactions require options" });
    const item = await agent.createInteraction(request.params.id, { runId: body.runId, ...(body.toolCallId ? { toolCallId: body.toolCallId } : {}), kind: body.kind as "confirm" | "single_select" | "multi_select" | "text", title: body.title, prompt: body.prompt, ...(body.options ? { options: body.options as Array<{ id: string; label: string; description?: string }> } : {}), ...(body.allowOther === true ? { allowOther: true } : {}) });
    return reply.code(201).send(item);
  });
  app.post<{ Params: { id: string; requestId: string }; Body: { answer: unknown } }>("/api/sessions/:id/interactions/:requestId/respond", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!request.body || !("answer" in request.body)) return reply.code(400).send({ error: "answer is required" });
    const interaction = await agent.respondInteraction(request.params.id, request.params.requestId, request.body.answer);
    if (!interaction) return reply.code(404).send({ error: "Pending interaction not found" });
    return interaction;
  });
  app.delete<{ Params: { id: string; steeringId: string } }>("/api/sessions/:id/steering/:steeringId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!(await agent.removeSteering(request.params.id, request.params.steeringId))) return reply.code(404).send({ error: "Steering item not found" });
    return reply.code(204).send();
  });

  // cron 定时任务（提交⑫）：调度/持久化在 CronScheduler，触发经 follow-up 队列注入
  app.get<{ Params: { id: string } }>("/api/sessions/:id/cron", async (request, reply) => {
    if (!dependencies.cron) return reply.code(501).send({ error: "Cron scheduler is not configured" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return dependencies.cron.list(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { cron?: string; prompt?: string; recurring?: boolean } }>("/api/sessions/:id/cron", async (request, reply) => {
    if (!dependencies.cron) return reply.code(501).send({ error: "Cron scheduler is not configured" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body.cron !== "string" || typeof body.prompt !== "string" || (body.recurring !== undefined && typeof body.recurring !== "boolean")) {
      return reply.code(400).send({ error: "cron (string) and prompt (string) are required; recurring must be a boolean" });
    }
    try {
      const job = await dependencies.cron.create(request.params.id, {
        cron: body.cron,
        prompt: body.prompt,
        ...(body.recurring === undefined ? {} : { recurring: body.recurring }),
      });
      return reply.code(201).send(job);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.delete<{ Params: { id: string; jobId: string } }>("/api/sessions/:id/cron/:jobId", async (request, reply) => {
    if (!dependencies.cron) return reply.code(501).send({ error: "Cron scheduler is not configured" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!(await dependencies.cron.delete(request.params.id, request.params.jobId))) return reply.code(404).send({ error: "Cron job not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (request, reply) => {
    if (!agent.abort(request.params.id)) return reply.code(409).send({ error: "Session is not running" });
    return reply.code(202).send({ accepted: true });
  });


  // ---- 人类终端 PTY 桥（提交⑦）----
  // 与 /api/events 并列的 WS 通道：握手复用 token/origin/host 三重校验（TOTP 启用时
  // bearer 或票据 cookie），再叠加终端门槛（TOTP 已启用 + 回环/局域网监听）。
  // 终端独立于 agent run：中断会话不影响终端；页面关闭（WS 断）即关 pty。
  app.get<{ Params: { id: string } }>("/api/sessions/:id/terminal", { websocket: true }, (socket, request) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const nativeClient = request.headers["x-openwebcode-client"] === "cli";
    const credentialOk = totpGateEnabled()
      ? bearerAuthorized(request, true) || totpAuthenticated(request)
      : isAuthorized(request, true);
    const hostHeader = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!credentialOk || !originAllowed(origin, nativeClient, hostHeader) || !hostAllowed(request.headers.host)) {
      socket.close(1008, "Unauthorized origin or token");
      return;
    }
    // 终端门槛：未通过时任何已认证页面都拿不到属主 shell
    if (!totpGateEnabled() || !isLoopbackOrLAN(listenHost)) {
      socket.close(1008, "Terminal is unavailable");
      return;
    }
    if (!core.openPty || !core.inputPty || !core.resizePty || !core.closePty || !core.ptyEvents) {
      socket.close(1011, "Terminal backend is unavailable");
      return;
    }
    const sessionId = request.params.id;
    const sessionPromise = sessions.get(sessionId).catch(() => undefined);
    let ptyId: number | undefined;
    const send = (frame: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
    };
    const closePty = () => {
      if (ptyId === undefined) return;
      const toClose = ptyId;
      ptyId = undefined;
      core.removePtyEvents?.(toClose);
      core.closePty?.({ ptyId: toClose }).catch(() => undefined);
    };
    socket.on("close", closePty);
    const dimension = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 512 ? value : undefined;
    socket.on("message", (raw: unknown) => {
      let frame: { type?: unknown; cols?: unknown; rows?: unknown; shell?: unknown; data?: unknown };
      try { frame = JSON.parse(String(raw)); } catch { send({ type: "error", message: "Invalid JSON frame" }); return; }
      void (async () => {
        try {
          if (frame.type === "open") {
            if (ptyId !== undefined) { send({ type: "error", message: "Terminal is already open" }); return; }
            const cols = dimension(frame.cols);
            const rows = dimension(frame.rows);
            if (cols === undefined || rows === undefined) { send({ type: "error", message: "open requires integer cols/rows from 1 to 512" }); return; }
            const shell = frame.shell === undefined
              ? (process.platform === "win32" ? "cmd.exe" : (typeof process.env.SHELL === "string" && process.env.SHELL.trim() ? process.env.SHELL : "/bin/sh"))
              : (typeof frame.shell === "string" && frame.shell.trim() ? frame.shell : undefined);
            if (shell === undefined) { send({ type: "error", message: "shell must be a non-empty string" }); return; }
            const session = await sessionPromise;
            if (!session) { send({ type: "error", message: "Session not found" }); socket.close(1008, "Session not found"); return; }
            // 人类终端通道：sandbox 强制 false（应用属主身份），cwd 取会话根
            const opened = await core.openPty!({ session: sessionId, cwd: session.cwd, cols, rows, sandbox: false, shell });
            ptyId = opened.ptyId;
            send({ type: "opened" });
            const emitter = core.ptyEvents!(opened.ptyId);
            emitter.on("output", (params: { data?: unknown }) => {
              if (params && typeof params.data === "string") send({ type: "out", data: params.data });
            });
            emitter.on("exit", (params: { exitCode?: unknown }) => {
              const code = params && typeof params.exitCode === "number" ? params.exitCode : undefined;
              send({ type: "exit", ...(code !== undefined ? { code } : {}) });
              closePty();
            });
            return;
          }
          if (frame.type === "in") {
            if (ptyId === undefined) { send({ type: "error", message: "Terminal is not open" }); return; }
            // core 侧还会再做规范 base64 + 解码后 ≤8KB 校验，这里只做形状预检
            if (typeof frame.data !== "string" || frame.data.length === 0 || frame.data.length > 16384) { send({ type: "error", message: "in requires non-empty base64 data" }); return; }
            await core.inputPty!({ ptyId, data: frame.data });
            return;
          }
          if (frame.type === "resize") {
            if (ptyId === undefined) { send({ type: "error", message: "Terminal is not open" }); return; }
            const cols = dimension(frame.cols);
            const rows = dimension(frame.rows);
            if (cols === undefined || rows === undefined) { send({ type: "error", message: "resize requires integer cols/rows from 1 to 512" }); return; }
            await core.resizePty!({ ptyId, cols, rows });
            return;
          }
          if (frame.type === "close") {
            closePty();
            socket.close(1000, "Terminal closed");
            return;
          }
          send({ type: "error", message: "Unknown frame type" });
        } catch (error) {
          send({ type: "error", message: errorMessage(error) });
        }
      })();
    });
  });
}
