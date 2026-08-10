import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import type { AgentRunner } from "./agent/agent-runner.js";
import type { BackgroundTaskRegistry } from "./agent/background-tasks.js";
import type { HookRunner } from "./hooks.js";
import { CoreRpcError, type CoreClientLike } from "./core-client.js";
import type { IndexManager } from "./index/index-manager.js";
import type { DiagnosticsService } from "./diagnostics/service.js";
import type { ScmService } from "./scm/service.js";
import { isLoopbackHost } from "./config.js";
import { TotpAuthService, TOTP_TICKET_TTL_MS, isLoopbackOrLAN } from "./auth-totp.js";
import { getModelProfile, listModelProfiles, type Currency, type ModelProfile } from "./context/model-profile.js";
import type { CatalogModel, ModelRegistry } from "./context/model-registry.js";
import type { PricingCatalog } from "./cost/pricing-catalog.js";
import type { AppEvent, EventBus } from "./events/event-bus.js";
import { DEFAULT_WS_BACKPRESSURE_LIMITS, isSlowClient, type WsBackpressureLimits } from "./events/ws-backpressure.js";
import type { ProviderRegistry } from "./providers/provider.js";
import { detectWsb } from "./sandbox/wsb.js";
import type { CoreRouter } from "./sandbox/core-router.js";
import { getSnapshotBackend } from "./snapshots/index.js";
import type { SnapshotBackend } from "./snapshots/backend.js";
import type { ManagedWorkspaceLike } from "./snapshots/managed-disk.js";
import type { SessionMeta, FallbackModelEntry } from "./sessions/types.js";
import type { ChatAssistantStore, ChatConfigService, ChatPythonEnv, ChatRunner, ChatSessionStore } from "./chat/index.js";
import type { SessionStore } from "./sessions/session-store.js";
import type { CronScheduler } from "./cron-scheduler.js";
import type { SettingsService } from "./settings-service.js";
import type { UpdateChecker } from "./update-checker.js";
import type { UpdateApplier } from "./update-applier.js";
import type { SkillRegistry } from "./skills.js";
import type { Compactor } from "./context/compactor.js";
import type { UsageLog } from "./usage-log.js";
import type { ExtensionManager } from "./extensions/extension-manager.js";
import type { ContentLensService } from "./extensions/content-lens.js";
import type { CompactVaultService } from "./extensions/compact-vault.js";
import type { ProviderProfilesService } from "./provider-profiles.js";
import type { ProviderProfilesRuntime } from "./provider-profiles-runtime.js";
import type { EvalEvaluator } from "./eval/evaluator.js";

import {
  parseCookies, safeTokenEqual, requestToken,
  isChatConversationRoute, isChatConfigRoute, isSharePublicRoute,
  type RouteContext,
} from "./routes/route-context.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import { registerSessionCoreRoutes } from "./routes/sessions-core.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSessionContextRoutes } from "./routes/sessions-context.js";
import { registerSessionInspectRoutes } from "./routes/sessions-inspect.js";
import { registerSessionFileRoutes } from "./routes/sessions-files.js";
import { registerSessionRunRoutes } from "./routes/sessions-run.js";
import { registerEvalRoutes } from "./routes/eval.js";

export interface ServerDependencies {
  core: CoreClientLike;
  sessions: SessionStore;
  agent: AgentRunner;
  events: EventBus;
  providers: ProviderRegistry;
  pricing: PricingCatalog;
  defaultCurrency?: Currency;
  defaultLanguage?: string;
  settings?: SettingsService;
  models?: ModelRegistry;
  usageLog?: UsageLog;
  skills?: SkillRegistry;
  compactor?: Compactor;
  /** 档案库压缩服务（compact-vault 官方扩展）；未注入且扩展启用时 /compact 走默认压缩 */
  vaultService?: CompactVaultService;
  /** 托管工作区管理器（plan §6.4）；未注入时 managed 相关路由 501 */
  managed?: ManagedWorkspaceLike;
  getPreferences?: () => { currency: Currency; language: string };
  webDist?: string;
  backgroundTasks?: BackgroundTaskRegistry;
  hooks?: HookRunner;
  extensions?: ExtensionManager;
  contentLens?: ContentLensService;
  providerProfiles?: ProviderProfilesService;
  providerProfilesRuntime?: ProviderProfilesRuntime;
  /** Remote-listener protection. Omitted for the loopback-only development default. */
  auth?: { accessToken: string; allowedOrigins: string[]; autoAllowSameOrigin?: boolean };
  /** 远程访问信息（/api/remote-access 供数）；regenerate 仅在 token 为自动生成时存在 */
  remoteAccess?: {
    host: string;
    port: number;
    tokenSource: "env" | "generated";
    lanAddresses: string[];
    regenerate?: () => Promise<string>;
  };
  /** 慢 WS 客户端背压阈值覆盖（测试用）；缺省用 ws-backpressure 的常量。 */
  wsBackpressureLimits?: Partial<WsBackpressureLimits>;
  /** 符号索引管理器（0.4.0 Phase 2）；未注入时 /api/workspaces/index/* 与 symbols 路由 501 */
  indexManager?: IndexManager;
  /** 诊断服务（0.4.0 Phase 3a）；未注入时 tests/diagnostics 路由 501 */
  diagnostics?: DiagnosticsService;
  /** SCM 服务（0.4.0 Phase 4a）；未注入时 git/* 路由 501 */
  scm?: ScmService;
  /** 评测 harness（0.5.0 Phase 3a）；扩展禁用时 eval/* 路由 503 */
  evalEvaluator?: EvalEvaluator;
  /** 更新检查（0.5.x）；未注入时 /api/update-check 返回 501 */
  updateChecker?: UpdateChecker;
  /** 在线更新执行器；未注入时 /api/update/apply 返回 501 */
  updateApplier?: UpdateApplier;
  /** 数据目录（提示词覆盖 REST 读写需要）；未注入时 /api/prompt 返回 501 */
  dataDir?: string;
  /** TOTP 全局登录认证（提交⑥）；未注入或默认关闭时门禁完全不生效 */
  totp?: TotpAuthService;
  /** 监听地址（/api/auth/status 的终端门槛判定用）；缺省按 127.0.0.1 */
  listenHost?: string;
  /** cron 定时任务调度器（提交⑫）；未注入时 /api/sessions/:id/cron 路由 501 */
  cron?: CronScheduler;
  /** 快照后端解析（测试注入用）；缺省走 probe 链 getSnapshotBackend */
  resolveSnapshotBackend?: (session: SessionMeta) => Promise<SnapshotBackend>;
  /** 平台覆盖（测试注入用）；缺省 process.platform。Linux 下会话创建会自动尝试 overlayfs 托管 */
  platform?: NodeJS.Platform;
  /** 聊天模式会话存储；未注入时 /api/chat/* 路由 503 */
  chatSessions?: ChatSessionStore;
  /** 聊天模式全局配置服务（<dataDir>/chat.json） */
  chatConfig?: ChatConfigService;
  /** 聊天执行引擎（消息运行/停止/SSE 增量） */
  chatRunner?: ChatRunner;
  /** 聊天助手预设存储 */
  chatAssistants?: ChatAssistantStore;
  /** 聊天模式 Python 环境（uv venv） */
  chatPythonEnv?: ChatPythonEnv;
  /** CoreRouter 单例（与 core 同实例）；chat 会话删除后释放 "chat-python-<id>" 的 core 侧配置。 */
  coreRouter?: CoreRouter;
}

/** Keep bootstrap credentials out of structured request logs. */
export function sanitizeRequestUrl(value: string): string {
  const separator = value.indexOf("?");
  if (separator < 0) return value;
  const params = new URLSearchParams(value.slice(separator + 1));
  if (!params.has("token")) return value;
  params.set("token", "[REDACTED]");
  return `${value.slice(0, separator)}?${params.toString()}`;
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { core, sessions, agent, events, providers, pricing } = dependencies;
  const platform = dependencies.platform ?? process.platform;
  // 首条用户消息派生标题（"New session" → 派生）与 PATCH 重命名走同一 session.updated 事件，通知所有客户端刷新列表
  sessions.onDerivedTitle = (meta) => {
    events.publish({ source: "session", type: "session.updated", sessionId: meta.id, payload: meta });
  };
  const defaultCurrency = dependencies.defaultCurrency ?? "CNY";
  const defaultLanguage = dependencies.defaultLanguage ?? "zh-CN";
  const getPreferences = dependencies.getPreferences ?? (() => ({ currency: defaultCurrency, language: defaultLanguage }));
  const app = Fastify({
    logger: {
      serializers: {
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: sanitizeRequestUrl(request.url),
            host: request.headers.host ?? "",
            remoteAddress: request.ip,
            ...(request.socket.remotePort === undefined ? {} : { remotePort: request.socket.remotePort }),
          };
        },
      },
    },
    bodyLimit: 1024 * 1024,
  });
  const auth = dependencies.auth;
  const isAuthorized = (request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, allowQueryToken = false) => !auth || safeTokenEqual(auth.accessToken, requestToken(request, allowQueryToken));
  // chat.json 的 lanUnauthenticated（缺省 true）内存缓存，避免每个请求读盘；
  // PUT /api/chat/config 保存成功后同步刷新该缓存
  const chatLanUnauth: { cache: boolean | undefined } = { cache: undefined };
  const chatLanUnauthenticated = async (): Promise<boolean> => {
    if (chatLanUnauth.cache !== undefined) return chatLanUnauth.cache;
    const config = dependencies.chatConfig ? await dependencies.chatConfig.get() : {};
    chatLanUnauth.cache = config.lanUnauthenticated !== false;
    return chatLanUnauth.cache;
  };
  // TOTP 全局登录（提交⑥）：与 OWC_ACCESS_TOKEN 并存。bearer 通道仅在配置了 access token 时存在；
  // totpEnabled 时 /api/** 与 WS 要求有效 TOTP 票据 cookie 或有效 bearer token。
  const totp = dependencies.totp;
  const listenHost = dependencies.listenHost ?? "127.0.0.1";
  const totpGateEnabled = (): boolean => totp !== undefined && totp.enabled();
  const bearerAuthorized = (request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, allowQueryToken = false): boolean =>
    auth !== undefined && safeTokenEqual(auth.accessToken, requestToken(request, allowQueryToken));
  const totpTicketOf = (request: { headers: Record<string, string | string[] | undefined> }): string | undefined =>
    parseCookies(typeof request.headers.cookie === "string" ? request.headers.cookie : undefined).get("owc_totp_session");
  const totpAuthenticated = (request: { headers: Record<string, string | string[] | undefined> }): boolean =>
    totp !== undefined && totp.validateTicket(totpTicketOf(request));
  const totpCookieHeader = (token: string): string =>
    `owc_totp_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(TOTP_TICKET_TTL_MS / 1_000)}`;
  const originAllowed = (origin: string | undefined, nativeClient: boolean, hostHeader?: string | undefined) => {
    if (auth) {
      if (!origin) return nativeClient;
      if (auth.allowedOrigins.includes(origin)) return true;
      // 未显式配置 origins 的非回环监听：放行与请求 Host 同源的浏览器 origin。
      // bearer token 仍是唯一凭证（SameSite=Strict cookie 不跨站携带），不扩大攻击面。
      if (auth.autoAllowSameOrigin && hostHeader) {
        try {
          return new URL(origin).host === hostHeader;
        } catch {
          return false;
        }
      }
      return false;
    }
    // 无认证（loopback 监听）模式：浏览器 Origin 必须指向本机，否则任意网页可跨域 WS 读取全部会话事件；
    // 不带 Origin 的非浏览器客户端（CLI 等）放行。
    if (origin === undefined) return true;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  };
  // 无认证模式下的 WS Host 校验：仅接受 loopback Host，挡住 DNS rebinding 之类经非本机 Host 的握手。
  const hostAllowed = (host: string | string[] | undefined): boolean => {
    if (auth) return true;
    const value = Array.isArray(host) ? host[0] : host;
    if (typeof value !== "string" || value === "") return false;
    const hostname = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0] ?? "";
    return isLoopbackHost(hostname);
  };
  // Loopback mode intentionally has no bearer token, so the Host header is
  // part of the trust boundary for every browser HTTP request.  Without this
  // check a DNS-rebinding page can become same-origin with 127.0.0.1 and call
  // file, extension, or execution APIs.  Keep WebSocket upgrades on the route
  // guard below so rejected handshakes still receive the documented 1008 close.
  app.addHook("onRequest", async (request, reply) => {
    const upgrade = Array.isArray(request.headers.upgrade) ? request.headers.upgrade[0] : request.headers.upgrade;
    if (!auth && upgrade?.toLowerCase() !== "websocket" && !hostAllowed(request.headers.host)) {
      return reply.code(403).send({ error: "Loopback mode requires a loopback Host header" });
    }
  });
  if (auth) {
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/")) {
        // A remote browser can bootstrap an HttpOnly, same-site cookie by
        // opening `/?token=...`; redirect before serving the app so the token
        // never reaches application JavaScript, page history, or subrequests.
        const queryToken = request.query && typeof request.query === "object"
          ? (request.query as Record<string, unknown>).token
          : undefined;
        if (request.method === "GET" && request.url.split("?", 1)[0] === "/" && typeof queryToken === "string" && safeTokenEqual(auth.accessToken, queryToken)) {
          reply.header("set-cookie", `owc_access_token=${encodeURIComponent(auth.accessToken)}; HttpOnly; SameSite=Strict; Path=/`);
          return reply.redirect("/");
        }
        return;
      }
      if (isAuthorized(request)) return;
      const pathname = request.url.split("?", 1)[0] ?? "";
      // 分享公开路由直接放行（校验口令在路由内完成）
      if (isSharePublicRoute(pathname)) return;
      // chat 对话路由 LAN 放行（chat.json lanUnauthenticated 缺省 true，置 false 时跳过；配置面路由不在此列）
      if (isChatConversationRoute(pathname) && !isChatConfigRoute(pathname) && (await chatLanUnauthenticated())) {
        const remoteAddr = request.socket.remoteAddress;
        if (remoteAddr && isLoopbackOrLAN(remoteAddr)) return;
      }
      // TOTP 已启用：/api/auth/* 匿名可达（登录入口）；有效 TOTP 票据与 bearer 并存放行
      if (totpGateEnabled()) {
        if (pathname.startsWith("/api/auth/")) return;
        if (totpAuthenticated(request)) return;
      }
      return reply.code(401).send({ error: "Authentication required" });
    });
  }
  // TOTP 全局登录门禁：除 /api/auth/*、/api/health 与静态资源外，/api/** 一律要求有效
  // TOTP 票据 cookie 或有效 bearer token；未启用（默认）时完全不生效。WS 升级不在此拦截，
  // 由 /api/events 路由守卫以 1008 关闭（与既有 origin/token 拒绝一致）。
  app.addHook("onRequest", async (request, reply) => {
    if (!totpGateEnabled()) return;
    if (!request.url.startsWith("/api/")) return;
    const upgrade = Array.isArray(request.headers.upgrade) ? request.headers.upgrade[0] : request.headers.upgrade;
    if (upgrade?.toLowerCase() === "websocket") return;
    const pathname = request.url.split("?", 1)[0] ?? "";
    if (pathname === "/api/health" || pathname.startsWith("/api/auth/")) return;
    // 分享公开路由与 LAN chat 对话路由同样免 TOTP 票据（与 bearer 门禁口径一致）
    if (isSharePublicRoute(pathname)) return;
    if (isChatConversationRoute(pathname) && !isChatConfigRoute(pathname) && (await chatLanUnauthenticated())) {
      const remoteAddr = request.socket.remoteAddress;
      if (remoteAddr && isLoopbackOrLAN(remoteAddr)) return;
    }
    if (bearerAuthorized(request)) return;
    if (totpAuthenticated(request)) {
      // 滑动续期：同步刷新 cookie Max-Age
      const ticket = totpTicketOf(request);
      if (ticket) reply.header("set-cookie", totpCookieHeader(ticket));
      return;
    }
    return reply.code(401).send({ error: "Authentication required" });
  });
  // 会话导入走 ndjson/纯文本原文，不经 JSON 解析
  app.addContentTypeParser(["application/x-ndjson", "text/plain"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  await app.register(websocket);
  if (dependencies.webDist && existsSync(dependencies.webDist)) {
    await app.register(fastifyStatic, { root: dependencies.webDist, prefix: "/" });
    // WebUI 静态资源安全响应头。CSP 限同源；index.html 含内联主题引导脚本，
    // 故 script-src 需 'unsafe-inline'（Monaco/KaTeX/shiki 均为打包本地资源，不需要 eval）。
    // style-src 'unsafe-inline'：React 组件/Monaco 会写内联 style。WS 走同源 connect-src。
    // 仅作用于非 /api 响应（JSON API 无渲染面，叠加 CSP 无意义）。
    app.addHook("onSend", async (request, reply) => {
      if (request.url.startsWith("/api/")) return;
      reply.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'");
      reply.header("X-Content-Type-Options", "nosniff");
    });
  }
  const clients = new Set<{ send(data: string): void; close(code?: number, reason?: string): void; readonly readyState: number; readonly bufferedAmount: number; pendingSends: number; sessionId?: string }>();
  // 慢客户端背压阈值：字节与消息数双上限（0.4.x §5.1），可用依赖覆盖便于测试。
  const wsLimits: WsBackpressureLimits = { ...DEFAULT_WS_BACKPRESSURE_LIMITS, ...dependencies.wsBackpressureLimits };
  let slowClientDisconnects = 0;
  let failedClientSends = 0;  // 已向 core 配置过 sandbox 的会话，避免文件浏览每次重配与 agent 运行竞态
  const configuredSessions = new Set<string>();
  // 同一 managed 会话一次只允许一个回源操作；同步期间 checkpoint/delete 也必须等待，
  // 避免镜像挂载树在三方指纹校验之后被另一条管理操作换叶或卸载。
  const managedSyncingSessions = new Set<string>();
  const managedSyncAbortControllers = new Map<string, AbortController>();
  // VHDX/qcow2 换叶会短暂卸载工作区。用服务端互斥防止双击、双标签页或 restore
  // 与 create 并发改同一条 chain；后台/快捷 shell 也必须先结束，不能持有挂载目录。
  const managedCheckpointingSessions = new Set<string>();
  // 快照回退全程持有（所有会话，不止 managed）：guard 检查到持有标记之间无 await，
  // 消息路由在 agent.run 前同步检查，关闭「回退进行中 run 起跑、随后触发消息被截断」的竞态
  const restoringSessions = new Set<string>();
  const resolveSnapshotBackend = dependencies.resolveSnapshotBackend ?? ((session: SessionMeta) => getSnapshotBackend(sessions, session, { core }));
  // Shared/exclusive gate for managed mount points. A checkpoint/sync/teardown
  // takes the exclusive side; core filesystem/exec and agent work hold a shared
  // lease until their promise settles. This closes the check-then-await race
  // where a VHDX could be dismounted halfway through an otherwise valid request.
  const managedWorkspaceUses = new Map<string, number>();
  type ManagedSession = { id: string; workspace?: { mode?: string } };
  const isManagedSession = (session: ManagedSession): boolean => session.workspace?.mode === "managed";
  const acquireManagedWorkspaceUse = (session: ManagedSession): (() => void) | undefined => {
    if (!isManagedSession(session)) return () => undefined;
    if (managedCheckpointingSessions.has(session.id) || managedSyncingSessions.has(session.id)) return undefined;
    managedWorkspaceUses.set(session.id, (managedWorkspaceUses.get(session.id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (managedWorkspaceUses.get(session.id) ?? 1) - 1;
      if (remaining <= 0) managedWorkspaceUses.delete(session.id);
      else managedWorkspaceUses.set(session.id, remaining);
    };
  };
  const acquireManagedWorkspaceExclusive = (session: ManagedSession, kind: "checkpoint" | "sync" | "teardown"): (() => void) | undefined => {
    if (!isManagedSession(session)) return () => undefined;
    if (managedCheckpointingSessions.has(session.id) || managedSyncingSessions.has(session.id) || (managedWorkspaceUses.get(session.id) ?? 0) > 0) return undefined;
    const set = kind === "sync" ? managedSyncingSessions : managedCheckpointingSessions;
    set.add(session.id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set.delete(session.id);
    };
  };
  type ManagedWorkspaceRunLease = {
    release: () => void;
    automaticSnapshotAllowed: boolean;
    downgradeAfterAutomaticSnapshot?: () => void;
  };
  /**
   * Reserve an automatic checkpoint before AgentRunner's first await.  This is
   * deliberately synchronous: a normal message run cannot sneak a VHD leaf
   * switch between the route's availability check and its shared lease.
   *
   * If another safe reader/exec is already using the workspace, retain a
   * shared lease and let AgentRunner report that this *automatic* checkpoint
   * was skipped.  A manual checkpoint remains available after that use ends.
   */
  const acquireManagedWorkspaceRun = (session: ManagedSession, reserveAutomaticCheckpoint: boolean): ManagedWorkspaceRunLease | undefined => {
    if (!isManagedSession(session)) return { release: () => undefined, automaticSnapshotAllowed: true };
    if (!reserveAutomaticCheckpoint) {
      const release = acquireManagedWorkspaceUse(session);
      return release ? { release, automaticSnapshotAllowed: false } : undefined;
    }
    const releaseExclusive = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseExclusive) {
      const releaseShared = acquireManagedWorkspaceUse(session);
      return releaseShared ? { release: releaseShared, automaticSnapshotAllowed: false } : undefined;
    }
    let releaseCurrent = releaseExclusive;
    let mode: "exclusive" | "shared" | "released" = "exclusive";
    const release = (): void => {
      if (mode === "released") return;
      mode = "released";
      releaseCurrent();
    };
    return {
      release,
      automaticSnapshotAllowed: true,
      downgradeAfterAutomaticSnapshot: () => {
        if (mode !== "exclusive") return;
        // Both calls are synchronous, so no other request can interleave and
        // acquire an exclusive lease in the hand-off gap.
        releaseCurrent();
        const releaseShared = acquireManagedWorkspaceUse(session);
        if (!releaseShared) {
          mode = "released";
          releaseCurrent = () => undefined;
          throw new Error("Managed workspace state changed while finishing automatic checkpoint");
        }
        releaseCurrent = releaseShared;
        mode = "shared";
      },
    };
  };
  const hasRunningBackgroundTask = (sessionId: string): boolean => dependencies.backgroundTasks?.hasRunningForSession(sessionId) ?? false;
  // Test/embedding shims predating shell shortcuts may only implement isRunning.
  const isShellPending = (sessionId: string): boolean => agent.isShellPending?.(sessionId) ?? false;
  const SANDBOX_MODES: readonly string[] = ["appcontainer", "wsb", "jobobject", "landlock", "bubblewrap", "off"];
  /** 平台门禁：win32 允许 appcontainer/jobobject/wsb/off；linux 允许 landlock/bubblewrap/off；其余平台仅 off */
  const sandboxModesForPlatform = (): readonly string[] =>
    platform === "win32" ? ["appcontainer", "wsb", "jobobject", "off"]
      : platform === "linux" ? ["landlock", "bubblewrap", "off"]
        : ["off"];
  /** 返回错误文案；合法或缺省返回 undefined。wsb 需本机 capability 可用 */
  const validateSandboxMode = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !SANDBOX_MODES.includes(value)) return "sandboxMode must be appcontainer, wsb, jobobject, landlock, bubblewrap, or off";
    if (!sandboxModesForPlatform().includes(value)) return `sandboxMode ${value} is not supported on platform ${platform}`;
    if (value === "wsb") {
      const wsb = detectWsb();
      if (!wsb.available) return `sandboxMode wsb 不可用：${wsb.reason ?? "Windows Sandbox 不可用"}`;
    }
    return undefined;
  };
  /** sandbox.network 校验：filtered 仅 Windows 接受（core 侧 Job Object 网络过滤）；合法或缺省返回 undefined */
  const validateSandboxNetwork = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !["allow", "deny", "filtered"].includes(value)) return "network must be allow, deny, or filtered";
    if (value === "filtered" && platform !== "win32") return `network filtered is not supported on platform ${platform}`;
    return undefined;
  };
  /** bindLinks 形状校验：≤16 项，元素仅含 virtPath/backingPath/readOnly。返回错误文案；合法或缺省返回 undefined */
  const validateBindLinks = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 16) return "bindLinks must be an array of at most 16 entries";
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "bindLinks entries must be objects";
      const record = entry as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["virtPath", "backingPath", "readOnly"].includes(key))) return "bindLinks entries allow only virtPath, backingPath, and readOnly";
      if (typeof record.virtPath !== "string" || !record.virtPath) return "bindLinks.virtPath must be a non-empty string";
      if (typeof record.backingPath !== "string" || !record.backingPath) return "bindLinks.backingPath must be a non-empty string";
      if (record.readOnly !== undefined && typeof record.readOnly !== "boolean") return "bindLinks.readOnly must be a boolean";
    }
    return undefined;
  };
  /** 会话级工具名单（toolsAllow/toolsDeny）形状校验：字符串数组；未知工具名不报错（过滤时静默忽略）。返回错误文案；合法或缺省返回 undefined */
  const validateToolNameList = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return `${field} must be an array of tool names`;
    return undefined;
  };
  /**
   * 备选模型链（fallbackModels）校验+归一化：形状校验（仅 provider/model 两键、非空字符串）；
   * 剔除与主模型重复或彼此重复的项；归一化后上限 3 个。fallback provider 未注册不报错
   * （运行期跳过未配置的候选，与角色链回落语义一致）。
   */
  const normalizeFallbackModels = (value: unknown, primary: { provider: string; model: string }): { entries?: FallbackModelEntry[]; error?: string } => {
    if (value === undefined || value === null) return {};
    if (!Array.isArray(value)) return { error: "fallbackModels must be an array of { provider, model }" };
    const seen = new Set<string>([`${primary.provider} ${primary.model}`]);
    const entries: FallbackModelEntry[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "fallbackModels entries must be objects with provider and model" };
      const record = item as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["provider", "model"].includes(key))) return { error: "fallbackModels entries allow only provider and model" };
      if (typeof record.provider !== "string" || !record.provider.trim()) return { error: "fallbackModels.provider must be a non-empty string" };
      if (typeof record.model !== "string" || !record.model.trim()) return { error: "fallbackModels.model must be a non-empty string" };
      const key = `${record.provider} ${record.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ provider: record.provider, model: record.model });
    }
    if (entries.length > 3) return { error: "fallbackModels allows at most 3 entries" };
    return { entries };
  };

  events.on("event", (event: AppEvent, published?: string) => {
    // EventBus 发布时已序列化一次（字节预算/历史留存），fan-out 直接复用；
    // fallback 兼容测试里手工 emit("event", event) 的场景。
    const serialized = published ?? JSON.stringify(event);
    for (const client of clients) {
      // 未带 sessionId 的 Web 客户端接收全量事件；显式会话订阅必须与
      // replay() 使用同一过滤语义，不能在实时阶段混入其他会话的状态。
      if (client.readyState !== 1 || (client.sessionId && event.sessionId && client.sessionId !== event.sessionId)) continue;
      if (isSlowClient(client, wsLimits)) {
        slowClientDisconnects++;
        try { client.send(JSON.stringify({ source: "server", type: "resync.required", seq: event.seq, createdAt: new Date().toISOString(), ...(client.sessionId ? { sessionId: client.sessionId, ...(event.sessionSeq !== undefined ? { sessionSeq: event.sessionSeq } : {}) } : {}), payload: { latestSeq: client.sessionId ? event.sessionSeq ?? 0 : event.seq, reason: "slow_client" } })); }
        catch { failedClientSends++; }
        try { client.close(1013, "Client is too slow; resync required"); }
        catch { /* The socket is already unusable; removing it below is sufficient. */ }
        clients.delete(client);
        continue;
      }
      try { client.send(serialized); }
      catch { failedClientSends++; clients.delete(client); }
    }
  });
  // /api/metrics 读取的 WS 发送侧计数（getter 透传本文件内的局部计数器）
  const wsStats = {
    get slowClientDisconnects(): number { return slowClientDisconnects; },
    get failedClientSends(): number { return failedClientSends; },
  };
  // 模型目录：registry（api/manual/builtin 三向合并）缺省时回退静态档案
  const catalog = (): Array<ModelProfile | CatalogModel> =>
    dependencies.models?.list() ?? listModelProfiles().map((profile) => ({ ...profile, source: "builtin" as const }));
  const profileOf = (model: string, provider?: string): ModelProfile => dependencies.models?.get(model, provider) ?? getModelProfile(model);
  const ctx: RouteContext = {
    dependencies,
    core, sessions, agent, events, providers, pricing,
    platform, defaultCurrency, defaultLanguage, getPreferences,
    auth,
    isAuthorized, bearerAuthorized,
    totp, listenHost, totpGateEnabled, totpTicketOf, totpAuthenticated, totpCookieHeader,
    originAllowed, hostAllowed,
    chatLanUnauth,
    clients, wsStats,
    configuredSessions, managedSyncingSessions, managedSyncAbortControllers, managedCheckpointingSessions, restoringSessions,
    resolveSnapshotBackend,
    isManagedSession, acquireManagedWorkspaceUse, acquireManagedWorkspaceExclusive, acquireManagedWorkspaceRun,
    hasRunningBackgroundTask, isShellPending,
    sandboxModesForPlatform, validateSandboxMode, validateSandboxNetwork, validateBindLinks, validateToolNameList, normalizeFallbackModels,
    catalog, profileOf,
  };
  // 路由按域拆分在 ./routes/*.ts；同域内保持原注册顺序（跨域路径前缀互不相交）。
  registerSystemRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerMiscRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerExtensionRoutes(app, ctx);
  registerSessionCoreRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerSessionContextRoutes(app, ctx);
  registerSessionInspectRoutes(app, ctx);
  registerSessionFileRoutes(app, ctx);
  registerSessionRunRoutes(app, ctx);

  app.get<{ Querystring: { after?: string; sessionId?: string } }>("/api/events", { websocket: true }, (socket, request) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const nativeClient = request.headers["x-openwebcode-client"] === "cli";
    // TOTP 已启用：有效票据 cookie 或 bearer 均可；未启用时保持既有判定
    const credentialOk = totpGateEnabled()
      ? bearerAuthorized(request, true) || totpAuthenticated(request)
      : isAuthorized(request, true);
    const hostHeader = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!credentialOk || !originAllowed(origin, nativeClient, hostHeader) || !hostAllowed(request.headers.host)) {
      socket.close(1008, "Unauthorized origin or token");
      return;
    }
    const parsedAfter = Number(request.query.after ?? 0);
    const after = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    const sessionId = request.query.sessionId;
    const replay = events.replaySerialized(after, sessionId);
    if (replay.requiresResync) {
      socket.send(JSON.stringify({
        source: "server",
        type: "resync.required",
        seq: replay.latestSeq,
        createdAt: new Date().toISOString(),
        ...(sessionId ? { sessionId, sessionSeq: replay.latestSeq } : {}),
        payload: { after, latestSeq: replay.latestSeq },
      }));
    } else {
      // 复用 EventBus 发布时算好的预序列化串，回放不再逐条 JSON.stringify
      for (const serialized of replay.serialized) socket.send(serialized);
    }
    const client = {
      get readyState(): number { return socket.readyState; },
      get bufferedAmount(): number { return socket.bufferedAmount; },
      // 已 send 未 flush 的消息条数：配合 bufferedAmount 构成双维度背压判定。
      pendingSends: 0,
      send: (data: string) => {
        client.pendingSends++;
        socket.send(data, (error) => {
          client.pendingSends = Math.max(0, client.pendingSends - 1);
          if (error) {
            failedClientSends++;
            clients.delete(client);
          }
        });
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
      ...(sessionId ? { sessionId } : {}),
    };
    clients.add(client);
    socket.send(JSON.stringify({ source: "server", type: "connected", seq: replay.latestSeq, createdAt: new Date().toISOString(), ...(sessionId ? { sessionId, sessionSeq: replay.latestSeq } : {}), payload: { latestSeq: replay.latestSeq } }));
    socket.on("close", () => clients.delete(client));
  });

  registerEvalRoutes(app, ctx);


  // SPA 兜底：非 /api 的 GET HTML 导航（含 /share/:shareId/:slug 前端路由）回退到 index.html；
  // 仅在 webDist 已注册静态托管时生效，其余一律 404 JSON。
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET"
      && !request.url.startsWith("/api/")
      && request.headers.accept?.includes("text/html")
      && dependencies.webDist
      && existsSync(dependencies.webDist)) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    let code = 500;
    if (normalized instanceof CoreRpcError) {
      if (normalized.code === -32602 || normalized.code === -32600) code = 400;
      else if (normalized.code === -32003) code = 404;
      else if (normalized.code === -32002) code = 403;
      else if (normalized.code === -32001) code = 504;
      else code = 502;
    } else if (normalized.message === "Invalid session ID") {
      code = 400;
    } else if ("code" in normalized && normalized.code === "FST_ERR_VALIDATION") {
      code = 400;
    }
    reply.code(code).send({ error: normalized.message });
  });

  return app;
}
