import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { FastifyReply } from "fastify";
import type { AgentRunner } from "../agent/agent-runner.js";
import type { CoreClientLike } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import type { ProviderRegistry } from "../providers/provider.js";
import type { PricingCatalog, SyncResult } from "../cost/pricing-catalog.js";
import type { Currency, EffortLevel, ModelModality, ModelPricing, ModelProfile, ThinkingMode } from "../context/model-profile.js";
import type { CatalogModel, ModelRegistry } from "../context/model-registry.js";
import type { SettingsService } from "../settings-service.js";
import { ManagedWorkspaceSyncError } from "../snapshots/managed-sync.js";
import type { SnapshotBackend } from "../snapshots/backend.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { BindLinkSpec, FallbackModelEntry, NodeEnv, PermissionMode, PythonEnv, SandboxMode, SandboxNetwork, SessionMeta, ShellBackend, SnapshotMode } from "../sessions/types.js";
import type { TotpAuthService } from "../auth-totp.js";
import type { ServerDependencies } from "../app.js";

export interface CreateSessionBody {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
  agentMode?: "plan" | "code" | "goal";
  sandboxMode?: SandboxMode;
  /** 会话网络策略（缺省 allow；filtered 仅 Windows） */
  network?: SandboxNetwork;
  setupScript?: string;
  /** 可选 Bind Link 目录绑定（Windows 11 24H2+，需 core 上报 features.bindLink 且以管理员权限运行）。 */
  bindLinks?: BindLinkSpec[];
  /** 缺省为直接模式；"managed" = 托管工作区（稀疏镜像盘挂载点作为会话 cwd） */
  workspaceMode?: "managed";
  /** 会话级内置工具白名单/黑名单（仅内置工具名；留空/缺省 = 不限制）。 */
  toolsAllow?: string[];
  toolsDeny?: string[];
  /** 会话级备选模型链（最多 3 个 provider/model 对；与主模型重复或彼此重复的项剔除）。 */
  fallbackModels?: FallbackModelEntry[];
}

export interface MessageBody {
  content: string;
  /** Explicit delivery intent; omitted remains compatible with pre-0.3 clients. */
  behavior?: "start" | "steer" | "follow_up";
  /** Caller-generated request identity for a retry-safe queued delivery. */
  requestId?: string;
  images?: Array<{ mediaType: string; data: string }>;
  /** @文件引用：server 在 appendMessage 前对每个 path 调 core.readFile（受沙盒），组装为前置 text 块 */
  attachments?: Array<{ path: string }>;
}

export interface PdfUploadBody {
  name?: unknown;
  data?: unknown;
}

export interface SessionConfigBody {
  provider?: string;
  model?: string;
  thinking?: ThinkingMode | null;
  effort?: EffortLevel | null;
  agentMode?: "plan" | "code" | "goal";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  /** 会话网络策略补丁（仅显式提供时更新；filtered 仅 Windows）。 */
  network?: SandboxNetwork;
  setupScript?: string;
  snapshotMode?: SnapshotMode;
  shellBackend?: ShellBackend;
  pythonEnv?: PythonEnv;
  nodeEnv?: NodeEnv;
  /** env-sim 人格预设 id（会话级覆盖）；空串清除。 */
  persona?: string;
  /** 会话级扩展状态补丁：key=扩展 id（必须已安装），value 为 JSON 对象（整体替换）或 null（清除）。 */
  extensionState?: Record<string, Record<string, unknown> | null>;
  /** 并行子代理（spawn_swarm）开关。 */
  swarmEnabled?: boolean;
  /** review 权限模式的审核模型来源；仅显式提供时更新。 */
  reviewModel?: "fast" | "main";
  /** 会话级内置工具白名单/黑名单补丁；null 或空数组清除，缺省保持不变。 */
  toolsAllow?: string[] | null;
  toolsDeny?: string[] | null;
  /** 会话级备选模型链补丁；null 或空数组清除，缺省保持不变（语义同 toolsAllow）。 */
  fallbackModels?: FallbackModelEntry[] | null;
}

export interface BudgetBody {
  maxSessionTokens?: number | null;
  maxSessionCost?: { amount: string; currency?: Currency | "RMB" } | null;
}

export const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image", "video"];
export const THINKING_MODES: readonly ThinkingMode[] = ["adaptive", "enabled", "disabled"];
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** files/raw 预览的扩展名 -> MIME 白名单（其余 415）。 */
export const RAW_PREVIEW_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};
/**
 * The global Fastify cap remains 1 MiB.  This route alone needs room for the
 * four allowed image inputs (up to 7,000,000 base64 characters each), which is
 * also how rendered PDF pages are submitted.  30 MiB leaves JSON-envelope
 * headroom without granting other API routes a larger upload surface.
 */
export const IMAGE_MESSAGE_BODY_LIMIT = 30 * 1024 * 1024;
/** PDF uploads are decoded before they enter the message pipeline. Keep this
 * route-local cap high enough for a 20 MiB PDF's base64 envelope, while the
 * global Fastify limit remains 1 MiB for all unrelated APIs. */
export const PDF_UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;
/** chat 图片面（uploads / 带图 messages）：10MB 图的 base64 信封约 14MB，20MB 留出 JSON 余量。 */
export const CHAT_IMAGE_BODY_LIMIT = 20 * 1024 * 1024;
export const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_UPLOAD_BASE64 = Math.ceil(MAX_PDF_UPLOAD_BYTES / 3) * 4;
/** Keep room for a `-<UUID>` suffix while staying below the 255-byte filename
 * component limit imposed by common Windows and POSIX filesystems. */
export const MAX_PDF_UPLOAD_NAME_BYTES = 200;
export const MAX_PDF_UPLOAD_NAME_CHARACTERS = 128;
export const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export const NO_PROVIDER_MESSAGE = "请先在设置中配置至少一个 API 密钥";

export function syncUrlNotConfigured(label: string): SyncResult {
  return { ok: false, error: `${label} sync URL is not configured` };
}

export function managedSyncFailure(reply: FastifyReply, error: unknown) {
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

export interface ManagedWorkspaceSyncBody {
  confirm?: boolean;
  previewFingerprint?: string;
  overwriteConflicts?: boolean;
}

export function parseCookies(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of value?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      const raw = item.slice(separator + 1).trim();
      try { result.set(item.slice(0, separator).trim(), decodeURIComponent(raw)); }
      catch { result.set(item.slice(0, separator).trim(), raw); }
    }
  }
  return result;
}

export function safeTokenEqual(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function maskAccessToken(token: string): string {
  if (token.length <= 12) return "••••••";
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
}

export function requestToken(request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, allowQueryToken = false): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7);
  const explicit = request.headers["x-openwebcode-token"];
  if (typeof explicit === "string") return explicit;
  const cookie = parseCookies(typeof request.headers.cookie === "string" ? request.headers.cookie : undefined).get("owc_access_token");
  if (cookie || !allowQueryToken || !request.query || typeof request.query !== "object") return cookie;
  const token = (request.query as Record<string, unknown>).token;
  return typeof token === "string" ? token : undefined;
}

export function serializePricing(pricing: ModelPricing): Record<string, string> {
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
export function resolveDefaultProvider(settings: SettingsService | undefined, providers: ProviderRegistry): string | undefined {
  const configured = settings ? new Set(settings.configuredProviderNames()) : undefined;
  return providers.list().find((name) => configured === undefined || configured.has(name));
}

/** chat 对话路由判定（/api/chat/sessions/* 与 /api/share/* 属对话面）。 */
export function isChatConversationRoute(pathname: string): boolean {
  return pathname.startsWith("/api/chat/sessions") || pathname.startsWith("/api/share/");
}

/** chat 配置路由判定（配置/助手面始终要求凭据，不走 LAN 免认证）。 */
export function isChatConfigRoute(pathname: string): boolean {
  return pathname === "/api/chat/config"
    || pathname === "/api/chat/models"
    || pathname === "/api/chat/assistants"
    || pathname.startsWith("/api/chat/assistants/");
}

/** 分享公开路由判定（含前端 SPA 分享页路径）。 */
export function isSharePublicRoute(pathname: string): boolean {
  return pathname.startsWith("/api/share/") || /^\/share\/[\w-]+\/[\w-]+$/.test(pathname);
}

export function resolveDefaultModel(provider: string, models: ModelRegistry | undefined): string {
  return models?.list().find((model) => model.provider === provider)?.id ?? "";
}

/**
 * settings 的 defaultModel（会话默认模型）：已配置、provider 仍启用且模型仍在目录中时，
 * 作为隐式会话创建（body 未指定 provider/model）的 provider+model；
 * 任一条件失效即回落"第一个已启用服务商 / 目录首模型"。只影响新会话创建。
 */
export function resolveDefaultSelection(
  settings: SettingsService | undefined,
  providers: ProviderRegistry,
  models: ModelRegistry | undefined,
): { provider: string; model: string } | undefined {
  const selection = settings?.effective().defaultModel;
  if (!selection || !providers.get(selection.provider)) return undefined;
  if (settings && !settings.configuredProviderNames().includes(selection.provider)) return undefined;
  if (models && !models.list().some((model) => model.provider === selection.provider && model.id === selection.model)) return undefined;
  return selection;
}

/**
 * Allow user-facing Unicode names, but never accept a pathname or a Windows
 * device name. The returned name is safe to join below .owc/uploads on every
 * supported host OS.
 */
export function safePdfUploadName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // `@` is meaningful to the message attachment parser.  Uploaded PDFs may
  // later be represented as a literal workspace path in a prompt, so normalize
  // it out of the stored name rather than allowing it to create an accidental
  // attachment reference (for example: "report @README.md.pdf").
  const name = value.normalize("NFC").replaceAll("@", "_");
  if (!name || name.length > MAX_PDF_UPLOAD_NAME_CHARACTERS || Buffer.byteLength(name, "utf8") > MAX_PDF_UPLOAD_NAME_BYTES || name.startsWith(".") || name.endsWith(".") || name.endsWith(" ")) return undefined;
  // eslint-disable-next-line no-control-regex -- 文件名校验需显式排除 NUL 与控制字符
  if (!name.toLowerCase().endsWith(".pdf") || /[\\/\u0000-\u001f<>:"|?*]/.test(name)) return undefined;
  if (WINDOWS_RESERVED_BASENAME.test(name)) return undefined;
  return name;
}

export function isBase64AlphabetCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b // +
    || code === 0x2f; // /
}

export function base64Digit(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/** Linear validation avoids regex engine stack limits for a legal 20 MiB PDF. */
export function isCanonicalBase64(value: string): boolean {
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
export function validatePdfUpload(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PDF_UPLOAD_BASE64 || !isCanonicalBase64(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PDF_UPLOAD_BYTES || bytes.toString("base64") !== value) return undefined;
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-" ? value : undefined;
}

export function pdfUploadPath(name: string): string {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  // A UUID makes this final component unguessable and collision-resistant.
  // Core owns parent traversal and the actual platform write, so there is no
  // host-side lstat → mkdir/write time-of-check/time-of-use window here.
  return path.posix.join(".owc", "uploads", `${stem}-${randomUUID()}${extension}`);
}

/** Bearer/TOTP 判定所需的最小请求形状（路由文件与 app.ts 共享）。 */
export type TokenRequestLike = { headers: Record<string, string | string[] | undefined>; query?: unknown };

/** /api/events WS 客户端（app.ts 的 fan-out 与 metrics 路由共享）。 */
export interface WsClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly bufferedAmount: number;
  pendingSends: number;
  sessionId?: string;
}

export type ManagedSession = { id: string; workspace?: { mode?: string } };

export type ManagedWorkspaceRunLease = {
  release: () => void;
  automaticSnapshotAllowed: boolean;
  downgradeAfterAutomaticSnapshot?: () => void;
};

/**
 * buildServer 装配的共享路由上下文：跨域共享的闭包状态（托管工作区租约、
 * 校验器、WS 客户端表等）在此汇聚，各 routes/*.ts 从 ctx 解构所需项。
 */
export interface RouteContext {
  dependencies: ServerDependencies;
  core: CoreClientLike;
  sessions: SessionStore;
  agent: AgentRunner;
  events: EventBus;
  providers: ProviderRegistry;
  pricing: PricingCatalog;
  platform: NodeJS.Platform;
  defaultCurrency: Currency;
  defaultLanguage: string;
  getPreferences: () => { currency: Currency; language: string };
  auth: ServerDependencies["auth"];
  isAuthorized: (request: TokenRequestLike, allowQueryToken?: boolean) => boolean;
  bearerAuthorized: (request: TokenRequestLike, allowQueryToken?: boolean) => boolean;
  totp: TotpAuthService | undefined;
  listenHost: string;
  totpGateEnabled: () => boolean;
  totpTicketOf: (request: { headers: Record<string, string | string[] | undefined> }) => string | undefined;
  totpAuthenticated: (request: { headers: Record<string, string | string[] | undefined> }) => boolean;
  totpCookieHeader: (token: string) => string;
  originAllowed: (origin: string | undefined, nativeClient: boolean, hostHeader?: string | undefined) => boolean;
  hostAllowed: (host: string | string[] | undefined) => boolean;
  /** chat.json lanUnauthenticated 内存缓存（PUT /api/chat/config 热刷新，onRequest 门禁读取）。 */
  chatLanUnauth: { cache: boolean | undefined };
  clients: Set<WsClient>;
  wsStats: { readonly slowClientDisconnects: number; readonly failedClientSends: number };
  configuredSessions: Set<string>;
  managedSyncingSessions: Set<string>;
  managedSyncAbortControllers: Map<string, AbortController>;
  managedCheckpointingSessions: Set<string>;
  restoringSessions: Set<string>;
  resolveSnapshotBackend: (session: SessionMeta) => Promise<SnapshotBackend>;
  isManagedSession: (session: ManagedSession) => boolean;
  acquireManagedWorkspaceUse: (session: ManagedSession) => (() => void) | undefined;
  acquireManagedWorkspaceExclusive: (session: ManagedSession, kind: "checkpoint" | "sync" | "teardown") => (() => void) | undefined;
  acquireManagedWorkspaceRun: (session: ManagedSession, reserveAutomaticCheckpoint: boolean) => ManagedWorkspaceRunLease | undefined;
  hasRunningBackgroundTask: (sessionId: string) => boolean;
  isShellPending: (sessionId: string) => boolean;
  sandboxModesForPlatform: () => readonly string[];
  validateSandboxMode: (value: unknown) => string | undefined;
  validateSandboxNetwork: (value: unknown) => string | undefined;
  validateBindLinks: (value: unknown) => string | undefined;
  validateToolNameList: (value: unknown, field: string) => string | undefined;
  normalizeFallbackModels: (value: unknown, primary: { provider: string; model: string }) => { entries?: FallbackModelEntry[]; error?: string };
  catalog: () => Array<ModelProfile | CatalogModel>;
  profileOf: (model: string, provider?: string) => ModelProfile;
}
