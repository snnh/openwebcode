import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorMessage } from "../error-utils.js";
import { timingSafeHashEqual } from "../auth-totp.js";
import type { MessageContent, TextContent } from "../sessions/types.js";
import type { ChatAssistant, ChatConfig, ChatImageInput, ChatRunner, ChatSessionMeta, ChatShare } from "../chat/index.js";
import { CHAT_IMAGE_MAX_BYTES, CHAT_INLINE_IMAGE_MAX_BYTES, extForMediaType, mediaTypeForFile, resolveSessionPath } from "../chat/index.js";
import { withTimeout } from "../http-utils.js";
import { CHAT_IMAGE_BODY_LIMIT } from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerChatRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { providers } = dependencies;
  const { chatLanUnauth, isAuthorized, totpAuthenticated } = ctx;


  // ---- 聊天模式（Chat）路由簇 ----
  // 对话面（/api/chat/sessions/*、/api/share/*）LAN 免认证（见 onRequest 门禁）；
  // 配置面（/api/chat/config|models|assistants）仍要求凭据。
  const chatSessions = dependencies.chatSessions;
  const chatConfig = dependencies.chatConfig;
  const chatRunner = dependencies.chatRunner;
  const chatAssistants = dependencies.chatAssistants;
  const chatUnavailable = () => ({ error: "Chat mode not available" });
  // chat SSE：每会话一组活跃 text/event-stream 连接，runner 文本增量/工具事件经此广播
  const chatStreamClients = new Map<string, Set<ServerResponse>>();
  const chatStreamSend = (sessionId: string, event: Record<string, unknown>): void => {
    const clients = chatStreamClients.get(sessionId);
    if (!clients) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  /** 出站序列化：剥离 share.passwordHash，以 hasPassword 布尔代替（store 内落盘数据不变）。 */
  const publicMeta = (meta: ChatSessionMeta): ChatSessionMeta => {
    if (!meta.share) return meta;
    const { passwordHash, ...shareRest } = meta.share;
    return { ...meta, share: { ...shareRest, hasPassword: passwordHash !== undefined } };
  };

  // 分享 token 的 HMAC secret：<dataDir>/chat-share-secret（lazy 创建，32 字节随机 hex，0600）；
  // 无 dataDir（测试注入面）时退化为进程期随机 secret，重启后 token 失效可接受
  let chatShareSecret: string | undefined;
  const getChatShareSecret = async (): Promise<string> => {
    if (chatShareSecret) return chatShareSecret;
    const dataDir = dependencies.dataDir;
    if (dataDir) {
      const filePath = path.join(dataDir, "chat-share-secret");
      try {
        const existing = (await readFile(filePath, "utf8")).trim();
        if (/^[0-9a-f]{64}$/.test(existing)) {
          chatShareSecret = existing;
          return existing;
        }
      } catch { /* 缺失/损坏则重建 */ }
      const secret = randomBytes(32).toString("hex");
      await writeFile(filePath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => undefined);
      chatShareSecret = secret;
      return secret;
    }
    chatShareSecret = randomBytes(32).toString("hex");
    return chatShareSecret;
  };
  /** 分享访问 token：HMAC-SHA256(secret, shareId:passwordHash)，无 secret 不可伪造 */
  const shareToken = async (shareId: string, passwordHash: string): Promise<string> =>
    createHmac("sha256", await getChatShareSecret()).update(`${shareId}:${passwordHash}`).digest("hex");

  // 分享口令校验限流：按 remoteAddress 连续 5 次失败锁 60 秒，成功清零（与 TOTP 登录限流同款语义）
  const SHARE_VERIFY_MAX_FAILURES = 5;
  const SHARE_VERIFY_LOCK_MS = 60_000;
  const shareVerifyAttempts = new Map<string, { failures: number; lockedUntil: number }>();
  const shareVerifyLockedSeconds = (ip: string): number => {
    const entry = shareVerifyAttempts.get(ip);
    if (!entry || entry.lockedUntil <= Date.now()) return 0;
    return Math.ceil((entry.lockedUntil - Date.now()) / 1_000);
  };
  const recordShareVerifyFailure = (ip: string): void => {
    const now = Date.now();
    let entry = shareVerifyAttempts.get(ip);
    if (!entry || entry.lockedUntil > now) {
      // 锁定期间不计数；无记录则新建
      if (entry) return;
      entry = { failures: 0, lockedUntil: 0 };
    }
    entry.failures += 1;
    // failures 不清零：锁定期满后下一次失败即重新锁定，避免每轮都换到完整 5 次尝试
    if (entry.failures >= SHARE_VERIFY_MAX_FAILURES) entry.lockedUntil = now + SHARE_VERIFY_LOCK_MS;
    shareVerifyAttempts.set(ip, entry);
  };

  // runner 的停止/Python 环境状态事件经可选回调桥接进 SSE（chat-runner.ts 声明同名回调后即生效）
  type ChatRunOptionalEvents = {
    onStopped?: () => void;
    onPythonStatus?: (status: "preparing" | "ready" | "error", detail?: string) => void;
    onThinkingDelta?: (text: string) => void;
  };
  /**
   * 启动一次 chat run（202 + runId 语义）。并发占用由 runner 入口同步登记兜底：
   * 登记失败抛 message 含 "already running" 的 Error，此处识别后返回 "conflict"（路由转 409）。
   */
  const startChatRun = async (
    runner: ChatRunner,
    params: {
      sessionId: string;
      userMessage: string;
      images?: ChatImageInput[];
      meta: ChatSessionMeta;
      log: FastifyRequest["log"];
    },
  ): Promise<{ runId: string } | "conflict"> => {
    const { sessionId } = params;
    const runId = randomUUID();
    let startError: unknown;
    const runParams: Parameters<ChatRunner["runChatMessage"]>[0] & ChatRunOptionalEvents = {
      sessionId,
      userMessage: params.userMessage,
      meta: params.meta,
      signal: withTimeout(undefined, 300_000),
      ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
      onDelta: (text) => chatStreamSend(sessionId, { type: "delta", runId, text }),
      onThinkingDelta: (text) => chatStreamSend(sessionId, { type: "thinking_delta", runId, text }),
      onToolCall: (call) => chatStreamSend(sessionId, { type: "tool_call", runId, ...call }),
      onToolResult: (result) => chatStreamSend(sessionId, { type: "tool_result", runId, ...result }),
      onStopped: () => chatStreamSend(sessionId, { type: "stopped", runId }),
      onPythonStatus: (status, detail) => chatStreamSend(sessionId, { type: "python_status", runId, status, ...(detail ? { detail } : {}) }),
    };
    let tracked: Promise<void>;
    try {
      tracked = Promise.resolve(runner.runChatMessage(runParams)).then(({ stopReason }) => {
        chatStreamSend(sessionId, { type: "done", runId, stopReason });
      }).catch((error: unknown) => {
        if (errorMessage(error).includes("already running")) {
          // 登记冲突：路由同步返回 409，不再发 SSE error
          startError = error;
          return;
        }
        // 浏览器已收到 202，详细失败留在 server 日志与 SSE error 事件中
        params.log.error({ err: error, sessionId }, "Chat run failed after accepting message");
        chatStreamSend(sessionId, { type: "error", runId, error: errorMessage(error) });
      });
    } catch (error) {
      if (errorMessage(error).includes("already running")) return "conflict";
      throw error;
    }
    void tracked;
    // runner 入口同步登记，冲突拒绝在微任务内到达上面的 catch；setImmediate 之后必已结算
    await new Promise((resolve) => setImmediate(resolve));
    if (startError !== undefined) return "conflict";
    return { runId };
  };
  app.get("/api/chat/sessions", async (_request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    return (await chatSessions.list()).map(publicMeta);
  });

  /** 创建会话：body 显式值 > defaultAssistantId 助手预设 > chat.json 全局默认。 */
  app.post<{ Body: { provider?: string; model?: string; title?: string; cwd?: string; assistantId?: string; systemPrompt?: string; enabledTools?: string[]; sandboxEnabled?: boolean; temperature?: number } }>("/api/chat/sessions", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const body = request.body ?? {};
    for (const key of ["provider", "model", "title", "cwd", "assistantId", "systemPrompt"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "string") return reply.code(400).send({ error: `${key} must be a string` });
    }
    if (body.enabledTools !== undefined && (!Array.isArray(body.enabledTools) || body.enabledTools.some((tool) => typeof tool !== "string"))) {
      return reply.code(400).send({ error: "enabledTools must be an array of strings" });
    }
    if (body.sandboxEnabled !== undefined && typeof body.sandboxEnabled !== "boolean") return reply.code(400).send({ error: "sandboxEnabled must be a boolean" });
    if (body.temperature !== undefined && typeof body.temperature !== "number") return reply.code(400).send({ error: "temperature must be a number" });
    const config = chatConfig ? await chatConfig.get() : {};
    const assistantId = body.assistantId ?? config.defaultAssistantId;
    const assistant = assistantId && chatAssistants ? await chatAssistants.get(assistantId) : undefined;
    const provider = body.provider ?? assistant?.provider ?? config.defaultProvider;
    const model = body.model ?? assistant?.model ?? config.defaultModel;
    if (!provider || !model) return reply.code(400).send({ error: "provider and model are required" });
    const systemPrompt = body.systemPrompt ?? (assistant?.systemPrompt ? assistant.systemPrompt : config.defaultSystemPrompt);
    const temperature = body.temperature ?? assistant?.temperature ?? config.defaultTemperature;
    const meta = await chatSessions.create({
      provider,
      model,
      ...(body.title ? { title: body.title } : {}),
      ...(body.cwd ? { cwd: body.cwd } : {}),
      ...(assistantId ? { assistantId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(body.enabledTools ?? assistant?.toolList ? { enabledTools: body.enabledTools ?? assistant?.toolList ?? [] } : {}),
      ...(body.sandboxEnabled !== undefined ? { sandboxEnabled: body.sandboxEnabled } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    });
    return reply.code(201).send(publicMeta(meta));
  });

  app.get<{ Params: { id: string } }>("/api/chat/sessions/:id", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const meta = await chatSessions.get(request.params.id);
    if (!meta) return reply.code(404).send({ error: "Session not found" });
    const messages = await chatSessions.getMessages(request.params.id);
    return { ...publicMeta(meta), messages };
  });

  /** 向上翻页：beforeId 之前（不含）的最近 limit 条；缺省 before 时返回全量。 */
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>("/api/chat/sessions/:id/messages", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const before = request.query.before;
    if (before !== undefined) {
      const limit = Math.max(1, Math.min(500, parseInt(request.query.limit ?? "50", 10) || 50));
      return { messages: await chatSessions.getMessagesBefore(request.params.id, before, limit) };
    }
    return { messages: await chatSessions.getMessages(request.params.id) };
  });

  /**
   * 会话配置补丁：title/provider/model/systemPrompt/assistantId/enabledTools/sandboxEnabled/temperature/cwd。
   * 仅 title 属对话面（LAN 免凭据）；含任何其他字段即配置面，与配置类路由同口径要求凭据。
   */
  app.patch<{ Params: { id: string }; Body: Partial<ChatSessionMeta> }>("/api/chat/sessions/:id", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "title") && !isAuthorized(request) && !totpAuthenticated(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    for (const key of ["title", "provider", "model", "systemPrompt", "assistantId", "cwd"] as const) {
      if (key in body && typeof body[key] !== "string") return reply.code(400).send({ error: `${key} must be a string` });
    }
    if ("enabledTools" in body && (!Array.isArray(body.enabledTools) || (body.enabledTools as unknown[]).some((tool) => typeof tool !== "string"))) {
      return reply.code(400).send({ error: "enabledTools must be an array of strings" });
    }
    if ("sandboxEnabled" in body && typeof body.sandboxEnabled !== "boolean") return reply.code(400).send({ error: "sandboxEnabled must be a boolean" });
    if ("temperature" in body && body.temperature !== null && typeof body.temperature !== "number") {
      return reply.code(400).send({ error: "temperature must be a number or null" });
    }
    const allowed = ["title", "provider", "model", "systemPrompt", "assistantId", "enabledTools", "sandboxEnabled", "temperature", "cwd"] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "No patchable fields provided" });
    const updated = await chatSessions.updateMeta(request.params.id, patch);
    return publicMeta(updated);
  });

  app.delete<{ Params: { id: string } }>("/api/chat/sessions/:id", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    await chatSessions.delete(request.params.id);
    // chat python 经 core 运行过时在 core 侧留有 "chat-python-<id>" 会话配置，随删除尽力释放
    await dependencies.coreRouter?.release(`chat-python-${request.params.id}`).catch(() => undefined);
    return reply.code(204).send();
  });

  /**
   * 发送消息：用户消息先落盘，runner 异步起跑（202 + runId），增量经 SSE 通道推送。
   * body 两种形态：旧 { text, images? }（text 视为单 text 块）或 content 块数组
   * （text / image；image 支持 base64 data ≤2MB 内嵌或 uploads/ ref 引用，单消息 ≤3 张）。
   */
  app.post<{ Params: { id: string }; Body: { text?: string; images?: { data: string; mediaType: string }[]; content?: unknown[] } }>(
    "/api/chat/sessions/:id/messages",
    { bodyLimit: CHAT_IMAGE_BODY_LIMIT },
    async (request, reply) => {
    if (!chatSessions || !chatRunner) return reply.code(503).send(chatUnavailable());
    const sessionId = request.params.id;
    const meta = await chatSessions.get(sessionId);
    if (!meta) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "message body is required" });
    // 快速路径预检；预检→起跑的竞态窗口由 runner 入口同步登记兜底（"already running" → 409）
    if (chatRunner.isRunning(sessionId)) return reply.code(409).send({ error: "Session is already running" });

    const userContent: MessageContent[] = [];
    const images: ChatImageInput[] = [];
    let text = "";
    /** image 块校验：data（base64 ≤2MB）或 ref（uploads//generated/ 内已存在文件）二选一。 */
    const pushImageBlock = async (raw: Record<string, unknown>): Promise<string | undefined> => {
      const mediaType = typeof raw.mediaType === "string" ? raw.mediaType : "";
      if (!extForMediaType(mediaType)) return "image mediaType must be image/png, image/jpeg, image/webp or image/gif";
      const hasData = typeof raw.data === "string" && raw.data.length > 0;
      const hasRef = typeof raw.ref === "string" && raw.ref.length > 0;
      if (hasData === hasRef) return "image block requires exactly one of data or ref";
      if (images.length >= 3) return "at most 3 images per message";
      if (hasData) {
        const bytes = Buffer.from(raw.data as string, "base64");
        if (bytes.length > CHAT_INLINE_IMAGE_MAX_BYTES) {
          return "image exceeds 2MB; upload it via POST /api/chat/sessions/:id/uploads and send the ref";
        }
        userContent.push({ type: "image", mediaType, data: raw.data as string });
        images.push({ mediaType, data: raw.data as string });
        return undefined;
      }
      const ref = raw.ref as string;
      if (!/^(uploads|generated)\/[^/\\]+$/.test(ref)) return "image ref must be an uploads/ or generated/ relative path";
      try {
        await stat(resolveSessionPath(chatSessions.sessionDir(sessionId), ref));
      } catch {
        return `image ref not found: ${ref}`;
      }
      userContent.push({ type: "image", mediaType, ref });
      images.push({ mediaType, ref });
      return undefined;
    };

    if (body.content !== undefined) {
      if (!Array.isArray(body.content)) return reply.code(400).send({ error: "content must be an array of blocks" });
      for (const block of body.content) {
        if (!block || typeof block !== "object") return reply.code(400).send({ error: "content blocks must be objects" });
        const raw = block as Record<string, unknown>;
        if (raw.type === "text") {
          if (typeof raw.text !== "string") return reply.code(400).send({ error: "text block requires a text string" });
          userContent.push({ type: "text", text: raw.text });
          text += (text ? "\n" : "") + raw.text;
        } else if (raw.type === "image") {
          const error = await pushImageBlock(raw);
          if (error) return reply.code(400).send({ error });
        } else {
          return reply.code(400).send({ error: `unsupported content block type: ${String(raw.type)}` });
        }
      }
    } else {
      if (typeof body.text !== "string" || !body.text.trim()) return reply.code(400).send({ error: "text is required" });
      text = body.text;
      userContent.push({ type: "text", text: body.text });
      if (body.images !== undefined) {
        if (!Array.isArray(body.images)) return reply.code(400).send({ error: "images must be an array" });
        for (const image of body.images) {
          const error = await pushImageBlock((image ?? {}) as Record<string, unknown>);
          if (error) return reply.code(400).send({ error });
        }
      }
    }
    // 纯图片消息（content 仅 image 块）允许 text 为空：vision 场景「贴图即问」
    if (userContent.length === 0) return reply.code(400).send({ error: "message content is required" });

    await chatSessions.appendMessage(sessionId, "user", userContent);
    // appendMessage 更新了 activeLeafId：必须重新读取 meta，陈旧对象会让 runner 用旧叶子算历史、
    // assistant 消息 parentId 悬挂
    const freshMeta = await chatSessions.get(sessionId);
    if (!freshMeta) return reply.code(404).send({ error: "Session not found" });
    const started = await startChatRun(chatRunner, {
      sessionId,
      userMessage: text,
      meta: freshMeta,
      log: request.log,
      ...(images.length > 0 ? { images } : {}),
    });
    if (started === "conflict") return reply.code(409).send({ error: "Session is already running" });
    return reply.code(202).send(started);
  });

  /** 上传图片：>2MB 图落盘 uploads/ 后以 ref 块引用（≤2MB 前端通常直接内嵌，接口不拒绝小图）。 */
  app.post<{ Params: { id: string }; Body: { data?: string; mediaType?: string; filename?: string } }>(
    "/api/chat/sessions/:id/uploads",
    { bodyLimit: CHAT_IMAGE_BODY_LIMIT },
    async (request, reply) => {
      if (!chatSessions) return reply.code(503).send(chatUnavailable());
      if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
      const body = request.body ?? {};
      if (typeof body.data !== "string" || !body.data) return reply.code(400).send({ error: "data must be a base64 string" });
      const mediaType = typeof body.mediaType === "string" ? body.mediaType.toLowerCase() : "";
      const ext = extForMediaType(mediaType);
      if (!ext) return reply.code(400).send({ error: "mediaType must be image/png, image/jpeg, image/webp or image/gif" });
      const bytes = Buffer.from(body.data, "base64");
      if (bytes.length > CHAT_IMAGE_MAX_BYTES) return reply.code(413).send({ error: "image exceeds 10MB" });
      const ref = `uploads/${randomUUID()}.${ext}`;
      const resolved = resolveSessionPath(chatSessions.sessionDir(request.params.id), ref);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, bytes);
      return reply.code(201).send({ ref });
    },
  );

  /** 按 ref 回图片：仅 uploads//generated/ 前缀白名单 + sessionDir 内路径防护。 */
  const sendChatImage = async (reply: FastifyReply, sessionDir: string, ref: string) => {
    if (!/^(uploads|generated)\/[^/\\]+$/.test(ref)) return reply.code(400).send({ error: "Invalid image ref" });
    const resolved = resolveSessionPath(sessionDir, ref);
    const mediaType = mediaTypeForFile(resolved);
    if (!mediaType) return reply.code(400).send({ error: "Invalid image ref" });
    try {
      const bytes = await readFile(resolved);
      return reply.header("Content-Type", mediaType).header("Cache-Control", "private, max-age=3600").send(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "Image not found" });
      throw error;
    }
  };
  app.get<{ Params: { id: string; "*": string } }>("/api/chat/sessions/:id/images/*", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const session = await chatSessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return sendChatImage(reply, chatSessions.sessionDir(session.id), request.params["*"]);
  });

  app.post<{ Params: { id: string } }>("/api/chat/sessions/:id/stop", async (request, reply) => {
    if (!chatRunner) return reply.code(503).send(chatUnavailable());
    chatRunner.stopChatMessage(request.params.id);
    return reply.code(204).send();
  });

  /** SSE 增量通道：connected 首帧后挂起，keepalive 15s；runner 事件经 chatStreamSend 广播。 */
  app.get<{ Params: { id: string } }>("/api/chat/sessions/:id/stream", async (request, reply) => {
    if (!chatSessions || !chatRunner) return reply.code(503).send(chatUnavailable());
    const sessionId = request.params.id;
    if (!(await chatSessions.get(sessionId))) return reply.code(404).send({ error: "Session not found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected", running: chatRunner.isRunning(sessionId) })}\n\n`);
    let clients = chatStreamClients.get(sessionId);
    if (!clients) {
      clients = new Set();
      chatStreamClients.set(sessionId, clients);
    }
    clients.add(reply.raw);
    const keepAlive = setInterval(() => {
      reply.raw.write(`: keepalive\n\n`);
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(reply.raw);
      if (clients.size === 0) chatStreamClients.delete(sessionId);
    });
  });

  /** 分支：复制当前活动路径到新会话（等价于从活动叶子 fork）。 */
  app.post<{ Params: { id: string } }>("/api/chat/sessions/:id/branches", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    try {
      const meta = await chatSessions.branch(request.params.id);
      return reply.code(201).send(meta);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message === "Session not found" ? 404 : 400).send({ error: message });
    }
  });

  /** fork：从指定消息（缺省当前活动叶子）复制活动路径到新会话。 */
  app.post<{ Params: { id: string }; Body: { messageId?: string } }>("/api/chat/sessions/:id/fork", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const messageId = request.body?.messageId;
    if (messageId !== undefined && (typeof messageId !== "string" || !messageId)) return reply.code(400).send({ error: "messageId must be a non-empty string" });
    try {
      const meta = await chatSessions.fork(request.params.id, messageId);
      return reply.code(201).send(meta);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message === "Session not found" ? 404 : 400).send({ error: message });
    }
  });

  /** checkout：切换活动叶子（meta-only）；messageId 不存在时 404。 */
  app.post<{ Params: { id: string }; Body: { messageId?: string } }>("/api/chat/sessions/:id/checkout", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const messageId = request.body?.messageId;
    if (typeof messageId !== "string" || !messageId) return reply.code(400).send({ error: "messageId is required" });
    if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (chatRunner?.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is already running" });
    try {
      return publicMeta(await chatSessions.checkout(request.params.id, messageId));
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message === "Message not found" ? 404 : 400).send({ error: message });
    }
  });

  /**
   * retry：对指定 assistant 消息重新生成。checkout 到其父消息（产生它的 user 消息成为
   * activeLeaf），随后以与 POST messages 相同的逻辑重新起跑（202 + runId）；旧分支保留在 JSONL。
   */
  app.post<{ Params: { id: string; messageId: string } }>("/api/chat/sessions/:id/messages/:messageId/retry", async (request, reply) => {
    if (!chatSessions || !chatRunner) return reply.code(503).send(chatUnavailable());
    const sessionId = request.params.id;
    if (!(await chatSessions.get(sessionId))) return reply.code(404).send({ error: "Session not found" });
    const messages = await chatSessions.getMessages(sessionId);
    const target = messages.find((message) => message.id === request.params.messageId);
    if (!target) return reply.code(404).send({ error: "Message not found" });
    if (target.role !== "assistant") return reply.code(400).send({ error: "Can only retry an assistant message" });
    if (!target.parentId) return reply.code(400).send({ error: "Assistant message has no parent to retry from" });
    if (chatRunner.isRunning(sessionId)) return reply.code(409).send({ error: "Session is already running" });
    const parent = messages.find((message) => message.id === target.parentId);
    const userMessage = parent?.role === "user"
      ? parent.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n")
      : "";
    // checkout 返回含新 activeLeafId 的最新 meta，直接交给 runner（与父链修复同一纪律）
    const freshMeta = await chatSessions.checkout(sessionId, target.parentId);
    const started = await startChatRun(chatRunner, { sessionId, userMessage, meta: freshMeta, log: request.log });
    if (started === "conflict") return reply.code(409).send({ error: "Session is already running" });
    return reply.code(202).send(started);
  });

  /**
   * edit：编辑指定 user 消息并重发。回溯到其父消息（活动叶子），把编辑后的文本作为
   * 新分支的 user 消息追加，随后按 POST messages 同逻辑起跑（202 + runId）；旧分支保留在 JSONL。
   * 与 retry 的差别：retry 复用原 user 消息文本，edit 由调用方给出新文本（仅允许纯文本编辑）。
   */
  app.post<{ Params: { id: string; messageId: string }; Body: { text?: string } }>("/api/chat/sessions/:id/messages/:messageId/edit", async (request, reply) => {
    if (!chatSessions || !chatRunner) return reply.code(503).send(chatUnavailable());
    const sessionId = request.params.id;
    if (!(await chatSessions.get(sessionId))) return reply.code(404).send({ error: "Session not found" });
    const messages = await chatSessions.getMessages(sessionId);
    const target = messages.find((message) => message.id === request.params.messageId);
    if (!target) return reply.code(404).send({ error: "Message not found" });
    if (target.role !== "user") return reply.code(400).send({ error: "Can only edit a user message" });
    const text = request.body?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text is required" });
    if (chatRunner.isRunning(sessionId)) return reply.code(409).send({ error: "Session is already running" });
    // 回溯到目标消息的父消息（store.retry 的同一原语），编辑内容作为新分支的 user 消息追加
    await chatSessions.retry(sessionId, target.id);
    await chatSessions.appendMessage(sessionId, "user", [{ type: "text", text }]);
    // appendMessage 更新了 activeLeafId：重新读取 meta（与 POST messages 同一纪律）
    const freshMeta = await chatSessions.get(sessionId);
    if (!freshMeta) return reply.code(404).send({ error: "Session not found" });
    const started = await startChatRun(chatRunner, { sessionId, userMessage: text, meta: freshMeta, log: request.log });
    if (started === "conflict") return reply.code(409).send({ error: "Session is already running" });
    return reply.code(202).send(started);
  });
  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/chat/sessions/:id/share", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const meta = await chatSessions.get(request.params.id);
    if (!meta) return reply.code(404).send({ error: "Session not found" });
    const password = request.body?.password;
    if (password !== undefined && typeof password !== "string") return reply.code(400).send({ error: "password must be a string" });
    const share: ChatShare = {
      id: randomUUID().replaceAll("-", "").slice(0, 8),
      // slug 只保留 [a-z0-9-]：CJK 等字符折叠为连字符，与 web 路由 / 公开面 gate 的 [\w-]+ 正则兼容；
      // 折叠重复 "-"、去首尾 "-"，空则回退 "chat"
      slug: meta.title.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "chat",
      createdAt: new Date().toISOString(),
      ...(password ? { passwordHash: createHash("sha256").update(password).digest("hex") } : {}),
    };
    const updated = await chatSessions.updateMeta(request.params.id, { share });
    return reply.code(201).send(publicMeta(updated).share);
  });

  app.delete<{ Params: { id: string } }>("/api/chat/sessions/:id/share", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    if (!(await chatSessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    await chatSessions.updateMeta(request.params.id, { share: undefined });
    return reply.code(204).send();
  });

  /** 导出对话：format=markdown（缺省）| json。 */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/chat/sessions/:id/export", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const meta = await chatSessions.get(request.params.id);
    if (!meta) return reply.code(404).send({ error: "Session not found" });
    const format = request.query.format ?? "markdown";
    if (format !== "markdown" && format !== "json") return reply.code(400).send({ error: 'format must be "markdown" or "json"' });
    const messages = await chatSessions.getMessages(request.params.id);
    if (format === "json") {
      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="chat-${meta.id}.json"`)
        .send(JSON.stringify({ meta: publicMeta(meta), messages }, null, 2));
    }
    const lines = [`# ${meta.title}\n`];
    for (const message of messages) {
      const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
      lines.push(`## ${role}\n`);
      for (const block of message.content) {
        if (block.type === "text") lines.push(`${block.text}\n`);
        else if (block.type === "image") lines.push(`> [image: ${block.mediaType}]\n`);
        else if (block.type === "tool_call") lines.push(`> Tool: ${block.name}\n`);
        else if (block.type === "tool_result") lines.push(`> Result: ${block.content}\n`);
        else if (block.type === "web_search_call") lines.push(`> [web search]\n`);
      }
    }
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="chat-${meta.id}.md"`)
      .send(lines.join("\n"));
  });

  // ---- chat 配置面（要求凭据，不走 LAN 免认证）----
  app.get("/api/chat/config", async (_request, reply) => {
    if (!chatConfig) return reply.code(503).send(chatUnavailable());
    return chatConfig.get();
  });

  app.put<{ Body: ChatConfig }>("/api/chat/config", async (request, reply) => {
    if (!chatConfig) return reply.code(503).send(chatUnavailable());
    if (!request.body || typeof request.body !== "object") return reply.code(400).send({ error: "config body is required" });
    await chatConfig.save(request.body);
    // 同步刷新 onRequest 门禁的 lanUnauthenticated 内存缓存（热生效，免重启）
    chatLanUnauth.cache = request.body.lanUnauthenticated !== false;
    return chatConfig.get();
  });

  /** 可用模型：已启用服务商 × 模型目录（无目录时 models 为空数组）；每个模型附能力声明供前端过滤。 */
  app.get("/api/chat/models", async () => {
    const view = dependencies.providerProfiles?.view();
    const providerIds = view ? view.modelProviders.filter((profile) => profile.enabled).map((profile) => profile.id) : providers.list();
    const catalogModels = dependencies.models?.list() ?? [];
    return providerIds.map((provider) => ({
      provider,
      models: catalogModels.filter((model) => model.provider === provider).map((model) => ({
        id: model.id,
        modalities: [...model.capabilities.modalities],
        imageOutput: model.capabilities.imageOutput,
      })),
    }));
  });

  app.get("/api/chat/assistants", async (_request, reply) => {
    if (!chatAssistants) return reply.code(503).send(chatUnavailable());
    return chatAssistants.list();
  });

  app.post<{ Body: { name?: string; description?: string; systemPrompt?: string; provider?: string; model?: string; temperature?: number; topP?: number; maxTokens?: number; reasoningLevel?: ChatAssistant["reasoningLevel"]; presetMessages?: ChatAssistant["presetMessages"]; toolList?: string[] } }>("/api/chat/assistants", async (request, reply) => {
    if (!chatAssistants) return reply.code(503).send(chatUnavailable());
    const body = request.body;
    if (!body || typeof body.name !== "string" || !body.name.trim()) return reply.code(400).send({ error: "name is required" });
    const assistant = await chatAssistants.create({
      name: body.name.trim(),
      systemPrompt: body.systemPrompt ?? "",
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.topP !== undefined ? { topP: body.topP } : {}),
      ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      ...(body.reasoningLevel !== undefined ? { reasoningLevel: body.reasoningLevel } : {}),
      ...(body.presetMessages !== undefined ? { presetMessages: body.presetMessages } : {}),
      ...(body.toolList !== undefined ? { toolList: body.toolList } : {}),
    });
    return reply.code(201).send(assistant);
  });

  app.patch<{ Params: { id: string }; Body: Partial<ChatAssistant> }>("/api/chat/assistants/:id", async (request, reply) => {
    if (!chatAssistants) return reply.code(503).send(chatUnavailable());
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = request.body ?? {};
    try {
      return await chatAssistants.update(request.params.id, patch);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/chat/assistants/:id", async (request, reply) => {
    if (!chatAssistants) return reply.code(503).send(chatUnavailable());
    await chatAssistants.delete(request.params.id);
    return reply.code(204).send();
  });

  // ---- 分享公开面（无凭据；口令校验在路由内）----
  /** 口令校验：无口令分享直接通过；有口令时 SHA-256 摘要比对；按 IP 连续 5 次失败锁 60 秒。 */
  app.post<{ Params: { shareId: string }; Body: { password?: string } }>("/api/share/:shareId/verify", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const shareId = request.params.shareId;
    if (!/^[0-9a-f]{8}$/.test(shareId)) return reply.code(400).send({ error: "Invalid share ID" });
    const ip = request.socket.remoteAddress ?? "unknown";
    const lockedSeconds = shareVerifyLockedSeconds(ip);
    if (lockedSeconds > 0) return reply.code(429).send({ error: `Too many attempts, try again in ${lockedSeconds}s` });
    const session = (await chatSessions.list()).find((entry) => entry.share?.id === shareId);
    if (!session?.share) return reply.code(404).send({ error: "Share not found" });
    if (session.share.passwordHash) {
      const password = request.body?.password;
      if (typeof password !== "string" || !password) return reply.code(401).send({ error: "Password required" });
      const hash = createHash("sha256").update(password).digest("hex");
      if (!timingSafeHashEqual(session.share.passwordHash, hash)) {
        recordShareVerifyFailure(ip);
        return reply.code(401).send({ error: "Invalid password" });
      }
      shareVerifyAttempts.delete(ip);
      // 颁发 token：HMAC-SHA256(secret, shareId:passwordHash)，供后续 messages 请求使用
      const token = await shareToken(shareId, session.share.passwordHash);
      return { verified: true, shareId: session.share.id, slug: session.share.slug, token };
    }
    return { verified: true, shareId: session.share.id, slug: session.share.slug };
  });

  /** 拉取被分享的对话（只读）。密码保护的分享需先通过 verify 获取 token。 */
  app.get<{ Params: { shareId: string }; Querystring: { token?: string } }>("/api/share/:shareId/messages", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const shareId = request.params.shareId;
    if (!/^[0-9a-f]{8}$/.test(shareId)) return reply.code(400).send({ error: "Invalid share ID" });
    const session = (await chatSessions.list()).find((entry) => entry.share?.id === shareId);
    if (!session?.share) return reply.code(404).send({ error: "Share not found" });
    // 密码保护：校验 verify 颁发的 token（HMAC-SHA256(secret, shareId:passwordHash)）
    if (session.share.passwordHash) {
      const token = request.query.token;
      if (!token) return reply.code(401).send({ error: "Password required" });
      const expected = await shareToken(shareId, session.share.passwordHash);
      if (!timingSafeHashEqual(expected, token)) return reply.code(401).send({ error: "Invalid token" });
    }
    const messages = await chatSessions.getMessages(session.id);
    return { title: session.title, slug: session.share.slug, messages };
  });

  /** 分享面的图片回读：与 messages 端点同款口令 token 校验 + ref 路径防护。 */
  app.get<{ Params: { shareId: string; "*": string }; Querystring: { token?: string } }>("/api/share/:shareId/images/*", async (request, reply) => {
    if (!chatSessions) return reply.code(503).send(chatUnavailable());
    const shareId = request.params.shareId;
    if (!/^[0-9a-f]{8}$/.test(shareId)) return reply.code(400).send({ error: "Invalid share ID" });
    const session = (await chatSessions.list()).find((entry) => entry.share?.id === shareId);
    if (!session?.share) return reply.code(404).send({ error: "Share not found" });
    if (session.share.passwordHash) {
      const token = request.query.token;
      if (!token) return reply.code(401).send({ error: "Password required" });
      const expected = await shareToken(shareId, session.share.passwordHash);
      if (!timingSafeHashEqual(expected, token)) return reply.code(401).send({ error: "Invalid token" });
    }
    return sendChatImage(reply, chatSessions.sessionDir(session.id), request.params["*"]);
  });
}
