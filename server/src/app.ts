import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "./agent/agent-runner.js";
import { SteeringError } from "./agent/agent-runner.js";
import type { BackgroundTaskRegistry } from "./agent/background-tasks.js";
import type { HookRunner } from "./hooks.js";
import { CoreRpcError, type CoreClientLike, type ExecRequest } from "./core-client.js";
import { ContextManager, type BudgetUpdate } from "./context/context-manager.js";
import { renderSessionHtml } from "./export-html.js";
import { boundToolResult } from "./context/tool-result-budget.js";
import type { ServerConfig } from "./config.js";
import { getModelProfile, listModelProfiles, type Currency, type EffortLevel, type ModelModality, type ModelPricing, type ModelProfile, type ThinkingMode } from "./context/model-profile.js";
import { lookupModelMetadata } from "./context/model-metadata.js";
import type { CatalogModel, ModelRegistry } from "./context/model-registry.js";
import { PricingValidationError, type PricingCatalog, type PricingDocument, type SyncResult } from "./cost/pricing-catalog.js";
import { parseDecimalToScaled } from "./cost/exchange-rate.js";
import type { AppEvent, EventBus } from "./events/event-bus.js";
import type { ProviderRegistry } from "./providers/provider.js";
import { detectWsb } from "./sandbox/wsb.js";
import { getSnapshotBackend } from "./snapshots/index.js";
import type { ManagedProvisionResult, ManagedWorkspaceLike } from "./snapshots/managed-disk.js";
import { ManagedWorkspaceSyncError, type ManagedWorkspaceSyncApplyInput } from "./snapshots/managed-sync.js";
import { SessionTransferError } from "./sessions/session-transfer.js";
import type { PermissionMode, SandboxMode, ShellBackend, SnapshotMode } from "./sessions/types.js";
import type { SessionStore } from "./sessions/session-store.js";
import { SettingsValidationError, type SettingsService } from "./settings-service.js";
import type { SkillRegistry } from "./skills.js";
import type { Compactor } from "./context/compactor.js";
import type { ContextPolicyUpdate } from "./context/context-manager.js";
import type { UsageLog } from "./usage-log.js";
import type { ExtensionManager } from "./extensions/extension-manager.js";
import type { ContentLensService } from "./extensions/content-lens.js";

interface CreateSessionBody {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
  agentMode?: "plan" | "build";
  sandboxMode?: SandboxMode;
  setupScript?: string;
  /** 缺省为直接模式；"managed" = 托管工作区（稀疏镜像盘挂载点作为会话 cwd） */
  workspaceMode?: "managed";
}

interface MessageBody {
  content: string;
  /** Explicit delivery intent; omitted remains compatible with pre-0.3 clients. */
  behavior?: "start" | "steer" | "follow_up";
  /** Caller-generated request identity for a retry-safe queued delivery. */
  requestId?: string;
  images?: Array<{ mediaType: string; data: string }>;
  /** @文件引用：server 在 appendMessage 前对每个 path 调 core.readFile（受沙盒），组装为前置 text 块 */
  attachments?: Array<{ path: string }>;
}

interface PdfUploadBody {
  name?: unknown;
  data?: unknown;
}

interface SessionConfigBody {
  provider?: string;
  model?: string;
  thinking?: ThinkingMode | null;
  effort?: EffortLevel | null;
  agentMode?: "plan" | "build";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  setupScript?: string;
  snapshotMode?: SnapshotMode;
  shellBackend?: ShellBackend;
}

interface BudgetBody {
  maxSessionTokens?: number | null;
  maxSessionCost?: { amount: string; currency?: Currency | "RMB" } | null;
}

const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image", "video"];
const THINKING_MODES: readonly ThinkingMode[] = ["adaptive", "enabled", "disabled"];
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * The global Fastify cap remains 1 MiB.  This route alone needs room for the
 * four allowed image inputs (up to 7,000,000 base64 characters each), which is
 * also how rendered PDF pages are submitted.  30 MiB leaves JSON-envelope
 * headroom without granting other API routes a larger upload surface.
 */
const IMAGE_MESSAGE_BODY_LIMIT = 30 * 1024 * 1024;
/** PDF uploads are decoded before they enter the message pipeline. Keep this
 * route-local cap high enough for a 20 MiB PDF's base64 envelope, while the
 * global Fastify limit remains 1 MiB for all unrelated APIs. */
const PDF_UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;
const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PDF_UPLOAD_BASE64 = Math.ceil(MAX_PDF_UPLOAD_BYTES / 3) * 4;
/** Keep room for a `-<UUID>` suffix while staying below the 255-byte filename
 * component limit imposed by common Windows and POSIX filesystems. */
const MAX_PDF_UPLOAD_NAME_BYTES = 200;
const MAX_PDF_UPLOAD_NAME_CHARACTERS = 128;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const NO_PROVIDER_MESSAGE = "请先在设置中配置至少一个 API 密钥";

function syncUrlNotConfigured(label: string): SyncResult {
  return { ok: false, error: `${label} sync URL is not configured` };
}

function managedSyncFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof ManagedWorkspaceSyncError) {
    const status = error.code === "confirmation_required" || error.code === "invalid_fingerprint" || error.code === "unsafe_path"
      ? 400
      : error.code === "apply_failed"
        ? 500
        : 409;
    return reply.code(status).send({ code: error.code.toUpperCase(), error: error.message });
  }
  return reply.code(500).send({ error: "Managed workspace sync failed" });
}

interface ManagedWorkspaceSyncBody {
  confirm?: boolean;
  previewFingerprint?: string;
  overwriteConflicts?: boolean;
}

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
  /** 托管工作区管理器（plan §6.4）；未注入时 managed 相关路由 501 */
  managed?: ManagedWorkspaceLike;
  getPreferences?: () => { currency: Currency; language: string };
  webDist?: string;
  backgroundTasks?: BackgroundTaskRegistry;
  hooks?: HookRunner;
  extensions?: ExtensionManager;
  contentLens?: ContentLensService;
  /** Remote-listener protection. Omitted for the loopback-only development default. */
  auth?: { accessToken: string; allowedOrigins: string[] };
}

function parseCookies(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of value?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0) result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return result;
}

function safeTokenEqual(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, allowQueryToken = false): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7);
  const explicit = request.headers["x-openwebcode-token"];
  if (typeof explicit === "string") return explicit;
  const cookie = parseCookies(typeof request.headers.cookie === "string" ? request.headers.cookie : undefined).get("owc_access_token");
  if (cookie || !allowQueryToken || !request.query || typeof request.query !== "object") return cookie;
  const token = (request.query as Record<string, unknown>).token;
  return typeof token === "string" ? token : undefined;
}

function serializePricing(pricing: ModelPricing): Record<string, string> {
  return {
    currency: pricing.currency,
    input: pricing.input.toString(),
    output: pricing.output.toString(),
    cacheRead: pricing.cacheRead.toString(),
    cacheWrite: pricing.cacheWrite.toString(),
  };
}

/**
 * A provider is selectable by default only after its credentials have been
 * configured.  Tests and embedders that do not provide SettingsService retain
 * the registry-only behaviour, which is also useful for injected test providers.
 */
function resolveDefaultProvider(settings: SettingsService | undefined, providers: ProviderRegistry): string | undefined {
  const configured = settings ? new Set(settings.configuredProviderNames()) : undefined;
  return providers.list().find((name) => configured === undefined || configured.has(name));
}

function resolveDefaultModel(provider: string, models: ModelRegistry | undefined): string {
  return models?.list().find((model) => model.provider === provider)?.id ?? "";
}

/**
 * Allow user-facing Unicode names, but never accept a pathname or a Windows
 * device name. The returned name is safe to join below .owc/uploads on every
 * supported host OS.
 */
function safePdfUploadName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // `@` is meaningful to the message attachment parser.  Uploaded PDFs may
  // later be represented as a literal workspace path in a prompt, so normalize
  // it out of the stored name rather than allowing it to create an accidental
  // attachment reference (for example: "report @README.md.pdf").
  const name = value.normalize("NFC").replaceAll("@", "_");
  if (!name || name.length > MAX_PDF_UPLOAD_NAME_CHARACTERS || Buffer.byteLength(name, "utf8") > MAX_PDF_UPLOAD_NAME_BYTES || name.startsWith(".") || name.endsWith(".") || name.endsWith(" ")) return undefined;
  if (!name.toLowerCase().endsWith(".pdf") || /[\\/\u0000-\u001f<>:"|?*]/.test(name)) return undefined;
  if (WINDOWS_RESERVED_BASENAME.test(name)) return undefined;
  return name;
}

function isBase64AlphabetCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b // +
    || code === 0x2f; // /
}

function base64Digit(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/** Linear validation avoids regex engine stack limits for a legal 20 MiB PDF. */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    if (!isBase64AlphabetCode(value.charCodeAt(index))) return false;
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  // RFC 4648's unused low bits must be zero. This makes `AB==` and `TWF=`
  // invalid rather than alternate spellings of the same bytes.
  if (padding === 2 && (base64Digit(value.charCodeAt(value.length - 3)) & 0x0f) !== 0) return false;
  if (padding === 1 && (base64Digit(value.charCodeAt(value.length - 2)) & 0x03) !== 0) return false;
  return true;
}

/** Strictly validate a conventional base64 PDF payload. Buffer.from() alone
 * is deliberately not used as validation because it accepts malformed input.
 * The validated canonical string is passed to core for the binary write so the
 * server never has to choose or open a host filesystem destination. */
function validatePdfUpload(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PDF_UPLOAD_BASE64 || !isCanonicalBase64(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PDF_UPLOAD_BYTES || bytes.toString("base64") !== value) return undefined;
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-" ? value : undefined;
}

function pdfUploadPath(name: string): string {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  // A UUID makes this final component unguessable and collision-resistant.
  // Core owns parent traversal and the actual platform write, so there is no
  // host-side lstat → mkdir/write time-of-check/time-of-use window here.
  return path.posix.join(".owc", "uploads", `${stem}-${randomUUID()}${extension}`);
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { core, sessions, agent, events, providers, pricing } = dependencies;
  const defaultCurrency = dependencies.defaultCurrency ?? "CNY";
  const defaultLanguage = dependencies.defaultLanguage ?? "zh-CN";
  const getPreferences = dependencies.getPreferences ?? (() => ({ currency: defaultCurrency, language: defaultLanguage }));
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  const auth = dependencies.auth;
  const isAuthorized = (request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, allowQueryToken = false) => !auth || safeTokenEqual(auth.accessToken, requestToken(request, allowQueryToken));
  const originAllowed = (origin: string | undefined, nativeClient: boolean) => !auth || (origin ? auth.allowedOrigins.includes(origin) : nativeClient);
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
          reply.header("set-cookie", `owc_access_token=${auth.accessToken}; HttpOnly; SameSite=Strict; Path=/`);
          return reply.redirect("/");
        }
        return;
      }
      if (isAuthorized(request)) return;
      return reply.code(401).send({ error: "Authentication required" });
    });
  }
  // 会话导入走 ndjson/纯文本原文，不经 JSON 解析
  app.addContentTypeParser(["application/x-ndjson", "text/plain"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  await app.register(websocket);
  if (dependencies.webDist && existsSync(dependencies.webDist)) {
    await app.register(fastifyStatic, { root: dependencies.webDist, prefix: "/" });
  }
  const clients = new Set<{ send(data: string): void; close(code?: number, reason?: string): void; readonly readyState: number; readonly bufferedAmount: number; sessionId?: string }>();
  const MAX_WS_BUFFERED_BYTES = 1 * 1024 * 1024;
  let slowClientDisconnects = 0;
  let failedClientSends = 0;
  // 已向 core 配置过 sandbox 的会话，避免文件浏览每次重配与 agent 运行竞态
  const configuredSessions = new Set<string>();
  // 同一 managed 会话一次只允许一个回源操作；同步期间 checkpoint/delete 也必须等待，
  // 避免镜像挂载树在三方指纹校验之后被另一条管理操作换叶或卸载。
  const managedSyncingSessions = new Set<string>();
  const managedSyncAbortControllers = new Map<string, AbortController>();
  // VHDX/qcow2 换叶会短暂卸载工作区。用服务端互斥防止双击、双标签页或 restore
  // 与 create 并发改同一条 chain；后台/快捷 shell 也必须先结束，不能持有挂载目录。
  const managedCheckpointingSessions = new Set<string>();
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
  const defaultSandbox = (cwd: string) => ({
    enabled: true,
    readRoots: [cwd],
    writeRoots: [cwd],
    denyPaths: [path.join(cwd, ".env")],
    network: "allow" as const,
  });
  const SANDBOX_MODES: readonly string[] = ["appcontainer", "wsb", "jobobject", "off"];
  /** 返回错误文案；合法或缺省返回 undefined。wsb 需本机 capability 可用 */
  const validateSandboxMode = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !SANDBOX_MODES.includes(value)) return "sandboxMode must be appcontainer, wsb, jobobject, or off";
    if (value === "wsb") {
      const wsb = detectWsb();
      if (!wsb.available) return `sandboxMode wsb 不可用：${wsb.reason ?? "Windows Sandbox 不可用"}`;
    }
    return undefined;
  };

  events.on("event", (event: AppEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState !== 1 || (client.sessionId && event.sessionId && client.sessionId !== event.sessionId)) continue;
      if (client.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
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

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/metrics", async () => ({ events: events.stats(), websocket: { clients: clients.size, slowClientDisconnects, failedClientSends } }));
  app.get("/api/core", async () => core.ping());
  app.get("/api/sandbox/capabilities", async () => ({ appcontainer: true, jobobject: true, off: true, wsb: detectWsb() }));
  app.get("/api/managed-workspace/capability", async (_request, reply) => {
    const managed = dependencies.managed;
    if (!managed) return reply.code(501).send({ error: "Managed workspace is not configured" });
    return managed.capability();
  });
  app.get("/api/providers", async () => providers.list());
  app.get("/api/extensions", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    return dependencies.extensions.list();
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
      return await extensions.configure(body.id, { ...(body.enabled === undefined ? {} : { enabled: body.enabled }), ...(body.config ? { config: body.config } : {}) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/extensions/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    try {
      await dependencies.extensions.uninstall(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // 模型目录：registry（api/manual/builtin 三向合并）缺省时回退静态档案
  const catalog = (): Array<ModelProfile | CatalogModel> =>
    dependencies.models?.list() ?? listModelProfiles().map((profile) => ({ ...profile, source: "builtin" as const }));
  const profileOf = (model: string): ModelProfile => dependencies.models?.get(model) ?? getModelProfile(model);
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
    const refreshed = await models.refresh({ ...(config.anthropic ? { anthropic: config.anthropic } : {}), ...(config.openai ? { openai: config.openai } : {}) });
    const url = config.models?.catalogSyncUrl;
    if (!url) return refreshed;
    return { ...refreshed, catalogSync: await models.syncCatalogFromUrl(url) };
  });
  app.put<{ Params: { id: string }; Body: Partial<CatalogModel> }>("/api/models/:id", async (request, reply) => {
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
        && typeof value.imageOutput === "boolean" && typeof value.tools === "boolean";
      if (!valid) return reply.code(400).send({ error: "capabilities must include modalities/thinking/effort arrays plus imageOutput and tools booleans" });
      const inRange = value.modalities.every((item) => MODEL_MODALITIES.includes(item as ModelModality))
        && value.thinking.every((item) => THINKING_MODES.includes(item as ThinkingMode))
        && value.effort.every((item) => EFFORT_LEVELS.includes(item as EffortLevel));
      if (!inRange) return reply.code(400).send({ error: "capabilities values out of range (modalities: text/image/video; thinking: adaptive/enabled/disabled; effort: low/medium/high/xhigh/max)" });
    }
    for (const key of ["contextWindow", "maxOutput"] as const) {
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1)) {
        return reply.code(400).send({ error: `${key} must be a positive integer` });
      }
    }
    // 已知模型沿用现有档案为底，未知模型经元数据库成档（保守默认）
    const known = models.list().find((entry) => entry.id === id);
    if (!known && body.provider === undefined) {
      return reply.code(400).send({ error: "provider is required for a new model" });
    }
    const metadata = lookupModelMetadata(id);
    const base: CatalogModel = known ?? {
      id,
      provider: "manual",
      source: "api",
      contextWindow: metadata.contextWindow,
      maxOutput: metadata.maxOutput,
      capabilities: metadata.capabilities,
    };
    const displayName = body.displayName ?? base.displayName;
    const model: CatalogModel = {
      ...base,
      provider: body.provider ?? base.provider,
      source: "manual",
      ...(displayName ? { displayName } : {}),
      contextWindow: body.contextWindow ?? base.contextWindow,
      maxOutput: body.maxOutput ?? base.maxOutput,
      capabilities: body.capabilities ?? base.capabilities,
    };
    await models.upsertManual(model);
    // Return the registry-normalized representation rather than echoing the
    // request body. This keeps the public capability contract closed (for
    // example, an unsupported videoOutput field is never reflected back).
    return { ...models.get(id), source: "manual" as const };
  });
  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const models = dependencies.models;
    if (!models) return reply.code(501).send({ error: "Model registry is not configured" });
    if (!models.isManual(request.params.id)) return reply.code(409).send({ error: "Only manual models can be deleted" });
    await models.removeManual(request.params.id);
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
  app.post<{ Body: ExecRequest }>("/api/exec", async (request, reply) => {
    if (managedSyncingSessions.has(request.body.sessionId)) return reply.code(409).send({ error: "Managed workspace sync is in progress" });
    if (managedCheckpointingSessions.has(request.body.sessionId)) return reply.code(409).send({ error: "Managed workspace checkpoint is in progress" });
    const session = await sessions.get(request.body.sessionId);
    const releaseWorkspace = session ? acquireManagedWorkspaceUse(session) : (() => undefined);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await core.run(request.body);
    } finally {
      releaseWorkspace();
    }
  });

  if (dependencies.settings) {
    const settings = dependencies.settings;
    app.get("/api/settings", async () => settings.view());
    app.put<{ Body: { overrides?: Record<string, unknown> } }>("/api/settings", async (request, reply) => {
      try {
        return await settings.update(request.body?.overrides ?? {});
      } catch (error) {
        if (error instanceof SettingsValidationError) return reply.code(400).send({ error: error.message });
        request.log.error(error, "Failed to persist server settings");
        return reply.code(500).send({ error: "Failed to persist server settings" });
      }
    });
  }

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
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
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
      const session = await sessions.create({
        ...rest,
        provider,
        model,
        id: sessionId,
        cwd: provisioned.mountPoint,
        workspace,
        snapshotBackend: `${provisioned.backend}-chain`,
      });
      events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
      // SessionStart 钩子：仅通知不阻断
      if (dependencies.hooks) await dependencies.hooks.run("SessionStart", { sessionId: session.id, cwd: session.cwd });
      return reply.code(201).send(session);
    } catch (error) {
      await managed.teardown({ id: sessionId, workspace }).catch(() => undefined);
      throw error;
    }
  };

  app.post<{ Body: CreateSessionBody }>("/api/sessions", async (request, reply) => {
    if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd) {
      return reply.code(400).send({ error: "cwd must be a non-empty string" });
    }
    const provider = request.body.provider ?? resolveDefaultProvider(dependencies.settings, providers);
    if (!provider) {
      return reply.code(400).send({ code: "NO_PROVIDER", message: NO_PROVIDER_MESSAGE, error: NO_PROVIDER_MESSAGE });
    }
    if (!providers.get(provider)) {
      return reply.code(400).send({ error: `Provider ${provider} is not configured` });
    }
    const model = request.body.model ?? resolveDefaultModel(provider, dependencies.models);
    const sandboxModeError = validateSandboxMode(request.body.sandboxMode);
    if (sandboxModeError) return reply.code(400).send({ error: sandboxModeError });
    if (request.body.agentMode !== undefined && !["plan", "build"].includes(request.body.agentMode)) {
      return reply.code(400).send({ error: 'agentMode must be "plan" or "build"' });
    }
    if (request.body.setupScript !== undefined && typeof request.body.setupScript !== "string") {
      return reply.code(400).send({ error: "setupScript must be a string" });
    }
    if (request.body.workspaceMode !== undefined && request.body.workspaceMode !== "managed") {
      return reply.code(400).send({ error: 'workspaceMode must be "managed"' });
    }
    if (request.body.workspaceMode === "managed") return createManagedSession(request.body, provider, model, reply);
    const session = await sessions.create({ ...request.body, provider, model });
    events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
    // SessionStart 钩子：仅通知不阻断
    if (dependencies.hooks) await dependencies.hooks.run("SessionStart", { sessionId: session.id, cwd: session.cwd });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions", async () => sessions.list());

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return session;
  });
  /** Read-only tree projection. Legacy sessions remain a single derived path. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/timeline", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return {
      activeLeafId: session.activeLeafId ?? session.messages.at(-1)?.id,
      entries: session.messages.map((message) => ({
        id: message.id, parentId: message.parentId,
        runId: message.runId, turnId: message.turnId,
        role: message.role, createdAt: message.createdAt,
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
    } catch (error) { return reply.code(error instanceof Error && error.message === "Session not found" ? 404 : 409).send({ error: error instanceof Error ? error.message : String(error) }); }
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

  app.get("/api/skills", async () => {
    const skills = dependencies.skills ? await dependencies.skills.listFor(undefined) : [];
    return { skills: skills.map(({ name, description, source, path: filePath }) => ({ name, description, source, path: filePath })) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/skills", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const skills = dependencies.skills ? await dependencies.skills.listFor(session.cwd) : [];
    return { skills: skills.map(({ name, description, source }) => ({ name, description, source })) };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/api/reports/cost", async (request, reply) => {
    if (!dependencies.usageLog) return reply.code(404).send({ error: "Usage log not enabled" });
    const { from, to } = request.query;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if ((from !== undefined && !datePattern.test(from)) || (to !== undefined && !datePattern.test(to))) {
      return reply.code(400).send({ error: "from/to 必须是 YYYY-MM-DD" });
    }
    const report = await dependencies.usageLog.report({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    // 会话可能已删除：title 查不到时缺省，前端回退为短 id
    const titles = new Map((await sessions.list()).map((item) => [item.id, item.title]));
    return {
      ...report,
      sessions: report.sessions.map((row) => ({ ...row, title: titles.get(row.sessionId) })),
      preferences: { currency: getPreferences().currency },
    };
  });

  app.put<{ Params: { id: string }; Body: SessionConfigBody }>("/api/sessions/:id/config", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update its config when it is idle" });
    const provider = request.body?.provider ?? session.provider;
    const model = request.body?.model ?? session.model;
    if (!providers.get(provider)) return reply.code(400).send({ error: `Provider ${provider} is not configured` });
    if (typeof model !== "string" || !model) return reply.code(400).send({ error: "model must be a non-empty string" });
    const profile = profileOf(model);
    const thinking = request.body && "thinking" in request.body ? request.body.thinking ?? undefined : session.thinking;
    const effort = request.body && "effort" in request.body ? request.body.effort ?? undefined : session.effort;
    if (thinking !== undefined && !profile.capabilities.thinking.includes(thinking)) {
      return reply.code(400).send({ error: `Model ${model} does not support thinking mode ${thinking}` });
    }
    if (effort !== undefined && !profile.capabilities.effort.includes(effort)) {
      return reply.code(400).send({ error: `Model ${model} does not support effort ${effort}` });
    }
    const agentMode = request.body && "agentMode" in request.body ? request.body.agentMode ?? undefined : session.agentMode;
    if (agentMode !== undefined && !["plan", "build"].includes(agentMode)) {
      return reply.code(400).send({ error: 'agentMode must be "plan" or "build"' });
    }
    const snapshotMode = request.body && "snapshotMode" in request.body ? request.body.snapshotMode ?? undefined : session.snapshotMode;
    if (snapshotMode !== undefined && !["auto", "manual"].includes(snapshotMode)) {
      return reply.code(400).send({ error: 'snapshotMode must be "auto" or "manual"' });
    }
    const shellBackend = request.body && "shellBackend" in request.body ? request.body.shellBackend ?? undefined : session.shellBackend;
    if (shellBackend !== undefined && !["default", "pwsh"].includes(shellBackend)) {
      return reply.code(400).send({ error: 'shellBackend must be "default" or "pwsh"' });
    }
    const permissionMode = request.body?.permissionMode ?? session.permissionMode ?? "ask";
    if (!["ask", "acceptEdits", "yolo"].includes(permissionMode)) return reply.code(400).send({ error: "permissionMode must be ask, acceptEdits, or yolo" });
    const touchesSandbox = Boolean(request.body && ("sandboxMode" in request.body || "setupScript" in request.body));
    if (touchesSandbox) {
      const sandboxModeError = validateSandboxMode(request.body?.sandboxMode);
      if (sandboxModeError) return reply.code(400).send({ error: sandboxModeError });
      if (request.body?.setupScript !== undefined && typeof request.body.setupScript !== "string") {
        return reply.code(400).send({ error: "setupScript must be a string" });
      }
    }
    if (touchesSandbox && session.sandboxMode === "wsb") {
      // WSB 的启动脚本和模式只在虚拟机启动时生效，切换前先释放旧实例。
      await core.release?.(session.id);
    }
    await sessions.updateConfig(request.params.id, { provider, model, ...(thinking ? { thinking } : {}), ...(effort ? { effort } : {}), ...(agentMode ? { agentMode } : {}), ...(snapshotMode ? { snapshotMode } : {}), ...(shellBackend ? { shellBackend } : {}) });
    let updated = await sessions.updatePermissions(request.params.id, permissionMode, session.permissionRules ?? []);
    if (touchesSandbox) {
      updated = await sessions.updateSandboxMode(request.params.id, request.body?.sandboxMode, request.body?.setupScript);
      configuredSessions.delete(session.id);
    }
    events.publish({ source: "session", type: "session.config_updated", sessionId: session.id, payload: updated });
    return updated;
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/context", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    const view = await manager.buildView(session.messages);
    const prefs = getPreferences();
    return { ...view, preferences: { language: prefs.language, currency: prefs.currency, currencyLabel: prefs.currency === "CNY" ? "RMB" : "USD" } };
  });

  app.put<{ Params: { id: string }; Body: BudgetBody }>("/api/sessions/:id/context/budget", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; update its budget when it is idle" });
    }
    const tokenValue = request.body?.maxSessionTokens;
    if (tokenValue !== null && tokenValue !== undefined && (!Number.isSafeInteger(tokenValue) || tokenValue < 1)) {
      return reply.code(400).send({ error: "maxSessionTokens must be a positive integer or null" });
    }
    let costValue: { currency: Currency; microUnits: string } | undefined;
    const requestedCost = request.body?.maxSessionCost;
    if (requestedCost !== null && requestedCost !== undefined) {
      const requestedCurrency = requestedCost.currency === "RMB" ? "CNY" : requestedCost.currency ?? getPreferences().currency;
      if (!requestedCost || typeof requestedCost.amount !== "string" || !["USD", "CNY"].includes(requestedCurrency)) {
        return reply.code(400).send({ error: "maxSessionCost must contain amount string and optional USD, CNY, or RMB currency, or null" });
      }
      try {
        costValue = {
          currency: requestedCurrency,
          microUnits: parseDecimalToScaled(requestedCost.amount, 1_000_000n).toString(),
        };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    const update: BudgetUpdate = {};
    if (request.body && "maxSessionTokens" in request.body) update.maxSessionTokens = tokenValue ?? undefined;
    if (request.body && "maxSessionCost" in request.body) update.maxSessionCost = costValue;
    const ledger = await manager.updateBudget(update);
    events.publish({ source: "session", type: "context.budget_updated", sessionId: request.params.id, payload: await manager.budgetStatus() });
    return ledger;
  });
  app.put<{ Params: { id: string }; Body: ContextPolicyUpdate }>("/api/sessions/:id/context/policy", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update context policy when it is idle" });
    try {
      const manager = new ContextManager(sessions.contextRoot(request.params.id));
      const ledger = await manager.updatePolicy(request.body ?? {});
      events.publish({ source: "session", type: "context.policy_updated", sessionId: request.params.id, payload: ledger.policy });
      return ledger;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
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
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
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
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get<{ Params: { id: string; artifactId: string }; Querystring: { offset?: string; limit?: string } }>("/api/sessions/:id/context/artifacts/:artifactId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const offset = Number(request.query.offset ?? 0);
    const limit = Number(request.query.limit ?? 64_000);
    try {
      return { content: await new ContextManager(sessions.contextRoot(request.params.id)).readArtifact(request.params.artifactId, offset, limit) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
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
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string }; Body: { text?: string; targetLanguage?: string } }>("/api/sessions/:id/content-lens/explain", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("content-lens")) return reply.code(409).send({ error: "content-lens extension is disabled" });
    if (!dependencies.contentLens) return reply.code(503).send({ error: "content-lens service is unavailable" });
    if (typeof request.body?.text !== "string" || (request.body.targetLanguage !== undefined && (typeof request.body.targetLanguage !== "string" || !request.body.targetLanguage.trim() || request.body.targetLanguage.length > 64))) return reply.code(400).send({ error: "text and a valid targetLanguage are required" });
    try { return await dependencies.contentLens.explain(request.params.id, request.body.text, request.body.targetLanguage ?? "zh-CN"); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      // 仅在 idle 且尚未配置时配置一次；运行中复用 agent 已配置的状态，避免竞态
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
        configuredSessions.add(session.id);
      }
      return await core.listFiles({ sessionId: request.params.id, path: request.query.path || "." });
    } finally {
      releaseWorkspace();
    }
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files/content", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "path is required" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
        configuredSessions.add(session.id);
      }
      return await core.readFile({ sessionId: request.params.id, path: request.query.path });
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
        await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
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
      const backend = await getSnapshotBackend(sessions, session);
      return { diff: await backend.diff(request.params.checkpointId) };
    } finally {
      releaseWorkspace();
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/snapshot-capability", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    return (await getSnapshotBackend(sessions, session)).capability();
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    const releaseWorkspace = acquireManagedWorkspaceUse(session);
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace checkpoint or sync is in progress" });
    try {
      return await (await getSnapshotBackend(sessions, session)).list();
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
      const backend = await getSnapshotBackend(sessions, session);
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
    const releaseWorkspace = acquireManagedWorkspaceExclusive(session, "checkpoint");
    if (!releaseWorkspace) return reply.code(409).send({ error: "Managed workspace is in use or its checkpoint is already in progress" });
    try {
      const backend = await getSnapshotBackend(sessions, session);
      const checkpoint = (await backend.list()).find((item) => item.id === request.params.checkpointId);
      if (!checkpoint) return reply.code(404).send({ error: "Checkpoint not found" });
      await backend.restore(checkpoint.id);
      if (!request.body?.filesOnly) { await sessions.truncateMessages(session.id, checkpoint.messageCount); await new ContextManager(sessions.contextRoot(session.id)).replaceLedger(checkpoint.ledger); }
      events.publish({ source: "session", type: "checkpoint.restored", sessionId: session.id, payload: { id: checkpoint.id, filesOnly: request.body?.filesOnly === true } }); return checkpoint;
    } finally {
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
      const backend = await getSnapshotBackend(sessions, session);
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
      if (!(await sessions.delete(request.params.id))) return reply.code(404).send({ error: "Session not found" });
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
    if (!task) return reply.code(404).send({ error: "Task not found" });
    return task;
  });

  // 上下文压缩（§7.4）：/compact（overview）、/compact tools（toolcalls），以及协议 REST 路由
  const runCompact = async (sessionId: string, mode: "toolcalls" | "overview") => {
    const result = await dependencies.compactor!.compact(sessionId, mode);
    if (result.changed) {
      events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: result.mode, uptoIndex: result.uptoIndex ?? 0, forced: false } });
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
    if (!dependencies.compactor) return reply.code(503).send({ error: "Compactor not enabled" });
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running" });
    const mode = request.body?.mode === "toolcalls" ? "toolcalls" : "overview";
    try {
      return await runCompact(request.params.id, mode);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
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
          await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
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
          if (!profile.capabilities.modalities.includes("image")) {
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
        const uptoIndex = session.messages.length;
        const ledger = await new ContextManager(sessions.contextRoot(request.params.id)).markCleared(uptoIndex);
        const at = ledger.cleared!.at;
        events.publish({ source: "agent", type: "context.cleared", sessionId: request.params.id, payload: { uptoIndex, at } });
        return reply.code(200).send({ accepted: true, cleared: true, uptoIndex, at });
      }
      const compactCommand = request.body.content.match(/^\/compact(?:\s+(tools?|toolcalls))?\s*$/i);
      if (compactCommand) {
        if (!dependencies.compactor) return reply.code(503).send({ error: "压缩器未启用" });
        if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "会话运行中，请先等待完成或中断后再压缩" });
        try {
          const result = await runCompact(request.params.id, compactCommand[1] ? "toolcalls" : "overview");
          return reply.code(200).send({ accepted: true, compacted: result.changed, result });
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
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
          return reply.code(code).send({ error: error instanceof Error ? error.message : String(error) });
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
            await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
            configuredSessions.add(session.id);
          }
          const contextRoot = sessions.contextRoot(request.params.id);
          for (const item of attachments) {
            const attachmentPath = item.path.trim();
            try {
              const result = await core.readFile({ sessionId: request.params.id, path: attachmentPath });
              const bounded = await boundToolResult(contextRoot, "read_file", result.content);
              attachmentBlocks.push({ text: `[Attachment ${attachmentPath}]\n${bounded.content}` });
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              attachmentBlocks.push({ text: `[Attachment ${attachmentPath}]\n错误：路径越界或不可读（${reason}）` });
            }
          }
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
  app.post<{ Params: { id: string }; Body: { runId?: string; toolCallId?: string; kind?: string; title?: string; prompt?: string; options?: Array<{ id?: string; label?: string; description?: string }> } }>("/api/sessions/:id/interactions", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body.runId !== "string" || typeof body.title !== "string" || typeof body.prompt !== "string" || !["confirm", "single_select", "multi_select", "text"].includes(body.kind ?? "") || (body.toolCallId !== undefined && typeof body.toolCallId !== "string") || (body.options !== undefined && (!Array.isArray(body.options) || body.options.some((option) => !option || typeof option.id !== "string" || typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string"))))) return reply.code(400).send({ error: "runId, kind, title, prompt, and valid optional options are required" });
    if (["single_select", "multi_select"].includes(body.kind!) && (!body.options || body.options.length === 0)) return reply.code(400).send({ error: "select interactions require options" });
    const item = await agent.createInteraction(request.params.id, { runId: body.runId, ...(body.toolCallId ? { toolCallId: body.toolCallId } : {}), kind: body.kind as "confirm" | "single_select" | "multi_select" | "text", title: body.title, prompt: body.prompt, ...(body.options ? { options: body.options as Array<{ id: string; label: string; description?: string }> } : {}) });
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

  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (request, reply) => {
    if (!agent.abort(request.params.id)) return reply.code(409).send({ error: "Session is not running" });
    return reply.code(202).send({ accepted: true });
  });

  app.get<{ Querystring: { after?: string; sessionId?: string } }>("/api/events", { websocket: true }, (socket, request) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const nativeClient = request.headers["x-openwebcode-client"] === "cli";
    if (!isAuthorized(request, true) || !originAllowed(origin, nativeClient)) {
      socket.close(1008, "Unauthorized origin or token");
      return;
    }
    const parsedAfter = Number(request.query.after ?? 0);
    const after = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    const sessionId = request.query.sessionId;
    const replay = events.replay(after, sessionId);
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
      for (const event of replay.events) socket.send(JSON.stringify(event));
    }
    const client = {
      get readyState(): number { return socket.readyState; },
      get bufferedAmount(): number { return socket.bufferedAmount; },
      send: (data: string) => socket.send(data),
      close: (code?: number, reason?: string) => socket.close(code, reason),
      ...(sessionId ? { sessionId } : {}),
    };
    clients.add(client);
    socket.send(JSON.stringify({ source: "server", type: "connected", seq: replay.latestSeq, createdAt: new Date().toISOString(), ...(sessionId ? { sessionId, sessionSeq: replay.latestSeq } : {}), payload: { latestSeq: replay.latestSeq } }));
    socket.on("close", () => clients.delete(client));
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
