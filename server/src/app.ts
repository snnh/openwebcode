import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "./agent/agent-runner.js";
import { SteeringError, SubAgentLaunchError, WorkspaceWriteDeniedError } from "./agent/agent-runner.js";
import type { BackgroundTaskRegistry } from "./agent/background-tasks.js";
import type { HookRunner } from "./hooks.js";
import { CoreRpcError, type CoreClientLike, type ExecRequest } from "./core-client.js";
import { IndexBuildingError, IndexUnavailableError, type IndexManager } from "./index/index-manager.js";
import type { DiagnosticsService } from "./diagnostics/service.js";
import type { ScmService } from "./scm/service.js";
import { ContextManager, isPathExcluded, type BudgetUpdate } from "./context/context-manager.js";
import { renderSessionHtml } from "./export-html.js";
import { renderSessionMarkdown } from "./export-markdown.js";
import { boundToolResult } from "./context/tool-result-budget.js";
import { errorMessage } from "./error-utils.js";
import type { ServerConfig } from "./config.js";
import { isLoopbackHost } from "./config.js";
import { buildAccessUrls } from "./access-token.js";
import { TotpAuthService, TOTP_TICKET_TTL_MS, isLoopbackOrLAN } from "./auth-totp.js";
import { getModelProfile, listModelProfiles, type Currency, type EffortLevel, type ModelModality, type ModelPricing, type ModelProfile, type ThinkingMode } from "./context/model-profile.js";
import { lookupModelMetadata } from "./context/model-metadata.js";
import type { CatalogModel, ModelRegistry } from "./context/model-registry.js";
import { PricingValidationError, type PricingCatalog, type PricingDocument, type SyncResult } from "./cost/pricing-catalog.js";
import { parseDecimalToScaled } from "./cost/exchange-rate.js";
import type { AppEvent, EventBus } from "./events/event-bus.js";
import { DEFAULT_WS_BACKPRESSURE_LIMITS, isSlowClient, type WsBackpressureLimits } from "./events/ws-backpressure.js";
import type { ProviderRegistry } from "./providers/provider.js";
import { detectWsb } from "./sandbox/wsb.js";
import { getSnapshotBackend } from "./snapshots/index.js";
import { createExecFileRunner, probeSnapshotBackend, probeSnapshotBackendByName } from "./snapshots/probe.js";
import type { SnapshotBackend } from "./snapshots/backend.js";
import type { ManagedProvisionResult, ManagedWorkspaceLike } from "./snapshots/managed-disk.js";
import { ManagedWorkspaceSyncError, type ManagedWorkspaceSyncApplyInput } from "./snapshots/managed-sync.js";
import { SessionTransferError } from "./sessions/session-transfer.js";
import { activePathMessages } from "./sessions/session-tree.js";
import { defaultSandboxPolicy } from "./sessions/default-sandbox.js";
import { resolveSessionPersona } from "./sessions/extension-state.js";
import type { BindLinkSpec, FallbackModelEntry, NodeEnv, PermissionMode, PythonEnv, SandboxMode, SandboxNetwork, SessionMeta, ShellBackend, SnapshotMode, TextContent } from "./sessions/types.js";
import type { SessionStore } from "./sessions/session-store.js";
import type { CronScheduler } from "./cron-scheduler.js";
import { SettingsValidationError, type SettingsService } from "./settings-service.js";
import { getServerVersion, GITHUB_REPO } from "./version.js";
import type { UpdateChecker } from "./update-checker.js";
import { UpdateApplyError, type UpdateApplier } from "./update-applier.js";
import { loadPromptOverride, loadScopedPromptOverride, writeGlobalPromptOverride, writeProjectPromptOverride, type PromptOverrideWriteBody } from "./agent/prompts/prompt-overrides.js";
import { INIT_COMMAND_PROMPT } from "./agent/prompts/init-prompt.js";
import { PI_BASE_SYSTEM_PROMPT, PI_PROMPT_VERSION } from "./agent/prompts/pi-base.js";
import type { SkillRegistry } from "./skills.js";
import { COMPACT_OVERVIEW_SYSTEM, COMPACT_TOOLCALLS_SYSTEM, type Compactor } from "./context/compactor.js";
import type { ContextPolicyUpdate } from "./context/context-manager.js";
import type { UsageLog } from "./usage-log.js";
import { ExtensionRouteError } from "./extensions/extension-manager.js";
import type { ExtensionManager } from "./extensions/extension-manager.js";
import { validateConfigAgainstSchema } from "./extensions/config-schema.js";
import type { ContentLensService } from "./extensions/content-lens.js";
import type { CompactVaultService } from "./extensions/compact-vault.js";
import { ProviderProfilesValidationError, normalizeModel, type ProviderProfilesService, type WebCapability } from "./provider-profiles.js";
import { testModelProviderConnection } from "./provider-connection-test.js";
import type { ProviderProfilesRuntime } from "./provider-profiles-runtime.js";
import type { EvalEvaluator } from "./eval/evaluator.js";

interface CreateSessionBody {
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

interface BudgetBody {
  maxSessionTokens?: number | null;
  maxSessionCost?: { amount: string; currency?: Currency | "RMB" } | null;
}

const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image", "video"];
const THINKING_MODES: readonly ThinkingMode[] = ["adaptive", "enabled", "disabled"];
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** files/raw 预览的扩展名 -> MIME 白名单（其余 415）。 */
const RAW_PREVIEW_MIME: Record<string, string> = {
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
}

function parseCookies(value: string | undefined): Map<string, string> {
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

/** Keep bootstrap credentials out of structured request logs. */
export function sanitizeRequestUrl(value: string): string {
  const separator = value.indexOf("?");
  if (separator < 0) return value;
  const params = new URLSearchParams(value.slice(separator + 1));
  if (!params.has("token")) return value;
  params.set("token", "[REDACTED]");
  return `${value.slice(0, separator)}?${params.toString()}`;
}

function safeTokenEqual(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function maskAccessToken(token: string): string {
  if (token.length <= 12) return "••••••";
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
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
 * settings 的 defaultModel（会话默认模型）：已配置、provider 仍启用且模型仍在目录中时，
 * 作为隐式会话创建（body 未指定 provider/model）的 provider+model；
 * 任一条件失效即回落"第一个已启用服务商 / 目录首模型"。只影响新会话创建。
 */
function resolveDefaultSelection(
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
function safePdfUploadName(value: unknown): string | undefined {
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
      // TOTP 已启用：/api/auth/* 匿名可达（登录入口）；有效 TOTP 票据与 bearer 并存放行
      if (totpGateEnabled()) {
        const pathname = request.url.split("?", 1)[0] ?? "";
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

  app.get("/api/health", async () => ({ status: "ok" }));

  // ---- TOTP 全局登录认证（提交⑥）：/api/auth/* 全组匿名可达（门禁豁免），登录限流在服务端内存 ----
  app.get("/api/auth/status", async (request) => {
    const enabled = totpGateEnabled();
    const lanOrLoopback = isLoopbackOrLAN(listenHost);
    const gateReasons: string[] = [];
    if (!enabled) gateReasons.push("totp_disabled");
    if (!lanOrLoopback) gateReasons.push("host_not_loopback_or_lan");
    return {
      totpEnabled: enabled,
      authenticated: enabled ? totpAuthenticated(request) || bearerAuthorized(request) : true,
      // 终端门槛（提交⑦预埋，本提交只暴露状态）：TOTP 已开启 且 监听地址回环或局域网
      terminalAvailable: enabled && lanOrLoopback,
      gateReasons,
    };
  });
  app.post("/api/auth/totp/setup", async (request, reply) => {
    if (!totp) return reply.code(501).send({ error: "TOTP is unavailable" });
    // 已启用时重设必须先通过现有认证（票据或 bearer），避免被匿名重置后顶替登录
    if (totp.enabled() && !totpAuthenticated(request) && !bearerAuthorized(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return totp.beginSetup();
  });
  app.post<{ Body: { code?: string } }>("/api/auth/totp/confirm", async (request, reply) => {
    if (!totp) return reply.code(501).send({ error: "TOTP is unavailable" });
    if (totp.enabled() && !totpAuthenticated(request) && !bearerAuthorized(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const code = request.body?.code;
    if (typeof code !== "string") return reply.code(400).send({ error: "code is required" });
    const recoveryCodes = await totp.confirmSetup(code);
    if (!recoveryCodes) return reply.code(400).send({ error: "Invalid code" });
    // 恢复码明文仅此一次返回
    return { recoveryCodes };
  });
  app.post<{ Body: { code?: string } }>("/api/auth/totp/disable", async (request, reply) => {
    if (!totp || !totp.enabled()) return reply.code(400).send({ error: "TOTP is not enabled" });
    if (!totpAuthenticated(request) && !bearerAuthorized(request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const code = request.body?.code;
    if (typeof code !== "string") return reply.code(400).send({ error: "code is required" });
    if (!(await totp.disable(code))) return reply.code(400).send({ error: "Invalid code" });
    return { ok: true };
  });
  app.post<{ Body: { code?: string } }>("/api/auth/login", async (request, reply) => {
    if (!totp || !totp.enabled()) return reply.code(400).send({ error: "TOTP is not enabled" });
    const lockedSeconds = totp.loginLockedSeconds(request.ip);
    if (lockedSeconds > 0) return reply.code(429).send({ error: "Too many attempts", retryAfterSeconds: lockedSeconds });
    const code = request.body?.code;
    if (typeof code !== "string" || code.trim() === "") return reply.code(400).send({ error: "code is required" });
    if (!(await totp.verifyLogin(code))) {
      totp.recordLoginFailure(request.ip);
      const nowLocked = totp.loginLockedSeconds(request.ip);
      return reply.code(401).send({ error: "Invalid code", ...(nowLocked > 0 ? { retryAfterSeconds: nowLocked } : {}) });
    }
    totp.recordLoginSuccess(request.ip);
    const ticket = totp.issueTicket();
    reply.header("set-cookie", totpCookieHeader(ticket));
    return { ok: true };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    totp?.revokeTicket(totpTicketOf(request));
    reply.header("set-cookie", "owc_totp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return { ok: true };
  });

  // ---- 远程访问（局域网/移动端）：令牌状态与一键访问链接 ----
  // 路由挂在 /api/ 下，自动进入既有 token/TOTP 认证链；完整链接只发给已认证请求。
  app.get("/api/remote-access", async () => {
    const remote = dependencies.remoteAccess;
    return {
      host: remote?.host ?? listenHost,
      port: remote?.port ?? null,
      authEnabled: auth !== undefined,
      tokenSource: remote?.tokenSource ?? null,
      maskedToken: auth ? maskAccessToken(auth.accessToken) : null,
      urls: auth && remote ? buildAccessUrls(remote.host, remote.port, remote.lanAddresses, auth.accessToken) : [],
    };
  });
  app.post("/api/remote-access/regenerate-token", async (_request, reply) => {
    const remote = dependencies.remoteAccess;
    if (!auth || !remote?.regenerate) {
      return reply.code(409).send({ error: "访问令牌由 OWC_ACCESS_TOKEN 环境变量显式配置，请在服务端环境中轮换" });
    }
    const token = await remote.regenerate();
    return {
      maskedToken: maskAccessToken(token),
      urls: buildAccessUrls(remote.host, remote.port, remote.lanAddresses, token),
      note: "旧访问链接与已写入的登录 Cookie 已失效，请用新链接重新打开",
    };
  });

  app.get("/api/metrics", async () => ({ events: events.stats(), websocket: { clients: clients.size, slowClientDisconnects, failedClientSends } }));
  app.get("/api/core", async () => core.ping());
  app.get("/api/version", async () => {
    const info = await core.ping();
    const snapshot = dependencies.updateChecker?.current();
    return {
      server: getServerVersion(),
      core: info.version,
      ...(info.protocolVersion ? { protocolVersion: info.protocolVersion } : {}),
      githubRepo: GITHUB_REPO,
      ...(snapshot
        ? { latestRelease: { version: snapshot.latestVersion, isNewer: snapshot.isNewer, htmlUrl: snapshot.htmlUrl, publishedAt: snapshot.publishedAt, checkedAt: snapshot.checkedAt } }
        : {}),
    };
  });
  app.get("/api/update-check", async (_request, reply) => {
    const checker = dependencies.updateChecker;
    if (!checker) return reply.code(501).send({ error: "Update checker is not configured" });
    return { snapshot: checker.current() ?? null };
  });
  app.post("/api/update-check/refresh", async (_request, reply) => {
    const checker = dependencies.updateChecker;
    if (!checker) return reply.code(501).send({ error: "Update checker is not configured" });
    const snapshot = await checker.refresh();
    return { snapshot: snapshot ?? null };
  });
  app.get("/api/update/apply", async (_request, reply) => {
    const applier = dependencies.updateApplier;
    if (!applier) return reply.code(501).send({ error: "Update applier is not configured" });
    return { state: applier.state() ?? null };
  });
  app.post("/api/update/apply", async (_request, reply) => {
    const applier = dependencies.updateApplier;
    if (!applier) return reply.code(501).send({ error: "Update applier is not configured" });
    try {
      const state = await applier.apply();
      return reply.code(202).send({ state });
    } catch (error) {
      // UpdateApplyError 携带语义化 statusCode（400 已是最新/平台不支持，409 已有进行中的更新）
      if (error instanceof UpdateApplyError) return reply.code(error.statusCode).send({ error: error.message });
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
  /** 项目作用域写入的 cwd 必须是一个已存在会话的工作目录（防任意路径写）。 */
  const isKnownSessionCwd = async (cwd: string): Promise<boolean> => {
    const target = path.resolve(cwd);
    const list = await sessions.list();
    return list.some((session) => path.resolve(session.cwd) === target);
  };
  const promptView = (override: Awaited<ReturnType<typeof loadPromptOverride>>) => ({
    builtinBase: PI_BASE_SYSTEM_PROMPT,
    builtinInitPrompt: INIT_COMMAND_PROMPT,
    builtinCompactOverviewPrompt: COMPACT_OVERVIEW_SYSTEM,
    builtinCompactToolcallsPrompt: COMPACT_TOOLCALLS_SYSTEM,
    promptVersion: PI_PROMPT_VERSION,
    identityOverride: override.identityOverride ?? null,
    baseOverride: override.baseOverride ?? null,
    customAppend: override.customAppend ?? null,
    subAgentAppend: override.subAgentAppend ?? null,
    initOverride: override.initOverride ?? null,
    compactOverviewOverride: override.compactOverviewOverride ?? null,
    compactToolcallsOverride: override.compactToolcallsOverride ?? null,
  });
  app.get<{ Querystring: { cwd?: string; scope?: string } }>("/api/prompt", async (request, reply) => {
    const dataDir = dependencies.dataDir;
    if (!dataDir) return reply.code(501).send({ error: "Prompt override is not configured" });
    const scope = typeof request.query.scope === "string" ? request.query.scope : "";
    const cwd = typeof request.query.cwd === "string" ? request.query.cwd : "";
    if (scope === "project") {
      if (!cwd || !(await isKnownSessionCwd(cwd))) return reply.code(400).send({ error: "scope=project requires cwd of an existing session" });
      return promptView(await loadScopedPromptOverride(path.join(cwd, ".owc")));
    }
    if (scope === "global") return promptView(await loadScopedPromptOverride(dataDir));
    // 旧契约：不带 scope 时按 内置->全局->项目 合并读取（cwd 可缺省）
    return promptView(await loadPromptOverride(dataDir, cwd));
  });
  app.put<{ Body: { scope?: string; cwd?: string; identityOverride?: string | null; baseOverride?: string | null; customAppend?: string | null; subAgentAppend?: string | null; initOverride?: string | null; compactOverviewOverride?: string | null; compactToolcallsOverride?: string | null } }>("/api/prompt", async (request, reply) => {
    const dataDir = dependencies.dataDir;
    if (!dataDir) return reply.code(501).send({ error: "Prompt override is not configured" });
    const body = request.body ?? {};
    // 全量替换语义：未以非空字符串给出的面一律删除对应文件（与恢复内置一致）
    const writeBody: PromptOverrideWriteBody = {
      ...(typeof body.identityOverride === "string" ? { identityOverride: body.identityOverride } : {}),
      ...(typeof body.baseOverride === "string" ? { baseOverride: body.baseOverride } : {}),
      ...(typeof body.customAppend === "string" ? { customAppend: body.customAppend } : {}),
      ...(typeof body.subAgentAppend === "string" ? { subAgentAppend: body.subAgentAppend } : {}),
      ...(typeof body.initOverride === "string" ? { initOverride: body.initOverride } : {}),
      ...(typeof body.compactOverviewOverride === "string" ? { compactOverviewOverride: body.compactOverviewOverride } : {}),
      ...(typeof body.compactToolcallsOverride === "string" ? { compactToolcallsOverride: body.compactToolcallsOverride } : {}),
    };
    try {
      if (body.scope === "project") {
        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        if (!cwd || !(await isKnownSessionCwd(cwd))) return reply.code(400).send({ error: "scope=project requires cwd of an existing session" });
        await writeProjectPromptOverride(cwd, writeBody);
      } else {
        await writeGlobalPromptOverride(dataDir, writeBody);
      }
      dependencies.agent.refreshPromptOverride();
      return { ok: true };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
  app.get("/api/sandbox/capabilities", async () => {
    const info = await core.ping().catch(() => undefined);
    const bindLinkAvailable = info?.features?.bindLink === true;
    const bwrap = info?.features?.bwrap;
    return {
      platform: process.platform,
      appcontainer: true,
      jobobject: true,
      off: true,
      wsb: detectWsb(),
      bindLink: {
        available: bindLinkAvailable,
        ...(bindLinkAvailable ? {} : { reason: "当前平台 core 未提供 Bind Link 能力（需要 Windows 11 24H2+ 的 bindflt；创建绑定还需以管理员权限运行）" }),
      },
      // core 未上报 features.bwrap（旧二进制）视为不可用
      bwrap: bwrap
        ? { available: bwrap.available, ...(bwrap.reason !== undefined ? { reason: bwrap.reason } : {}) }
        : { available: false },
    };
  });
  app.get("/api/managed-workspace/capability", async (_request, reply) => {
    const managed = dependencies.managed;
    if (!managed) return reply.code(501).send({ error: "Managed workspace is not configured" });
    return managed.capability();
  });
  app.get("/api/providers", async () => providers.list());
  /** 0.5.0 Phase 2：per-provider 并发与队列深度诊断 */
  app.get("/api/providers/stats", async () => providers.concurrencyStats());
  if (dependencies.providerProfiles) {
    const profiles = dependencies.providerProfiles;
    const profileFailure = (reply: FastifyReply, error: unknown) => reply
      .code(error instanceof ProviderProfilesValidationError ? 400 : 500)
      .send({ error: errorMessage(error) });
    app.get("/api/provider-profiles", async () => profiles.view());
    // 候选配置连接测试：不落盘，直接对表单值做最小化认证请求
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/test", async (request, reply) => {
      try {
        const profile = normalizeModel(request.body ?? {});
        return await testModelProviderConnection(profile);
      } catch (error) { return profileFailure(reply, error); }
    });
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/models", async (request, reply) => {
      try { return await profiles.upsertModel(undefined, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/provider-profiles/models/:id", async (request, reply) => {
      try { return await profiles.upsertModel(request.params.id, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.delete<{ Params: { id: string } }>("/api/provider-profiles/models/:id", async (request, reply) => {
      try { return await profiles.deleteModel(request.params.id); } catch (error) { return profileFailure(reply, error); }
    });
    app.post<{ Body: Record<string, unknown> }>("/api/provider-profiles/web", async (request, reply) => {
      try { return await profiles.upsertWeb(undefined, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/provider-profiles/web/:id", async (request, reply) => {
      try { return await profiles.upsertWeb(request.params.id, request.body ?? {}); } catch (error) { return profileFailure(reply, error); }
    });
    app.delete<{ Params: { id: string } }>("/api/provider-profiles/web/:id", async (request, reply) => {
      try { return await profiles.deleteWeb(request.params.id); } catch (error) { return profileFailure(reply, error); }
    });
    app.put<{ Params: { capability: WebCapability }; Body: { id?: string | null } }>("/api/provider-profiles/web-active/:capability", async (request, reply) => {
      if (request.params.capability !== "search" && request.params.capability !== "fetch") return reply.code(400).send({ error: "capability must be search or fetch" });
      try { return await profiles.selectWeb(request.params.capability, request.body?.id ?? null); } catch (error) { return profileFailure(reply, error); }
    });
  }
  app.get("/api/extensions", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    const list = dependencies.extensions.list();
    // env-sim：附加可选预设列表供 UI 下拉（内置 + 用户目录发现）
    const envSim = list.find((item) => item.id === "env-sim");
    if (envSim) envSim.availablePersonas = (await dependencies.extensions.listEnvSimPersonas()).personas;
    return list;
  });
  app.get("/api/extensions/env-sim/personas", async (_request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    // 预设清单 + 用户预设目录绝对路径（UI 提示用户把分享的预设 JSON 放进来）
    return dependencies.extensions.listEnvSimPersonas();
  });
  app.get<{ Params: { id: string } }>("/api/extensions/env-sim/personas/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    // 完整预设详情：UI 选前预览（identity/basePrompt/productSections/hideBuiltIns/aliases）
    const detail = await dependencies.extensions.envSimPersonaDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "Persona not found" });
    return detail;
  });
  app.post("/api/extensions/env-sim/personas", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    // 新建/覆盖用户预设：形状/id 校验在 saveUserPreset（同 id 覆盖即编辑）
    try {
      return reply.code(201).send(await dependencies.extensions.createEnvSimPersona(request.body));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/extensions/env-sim/personas/:id", async (request, reply) => {
    if (!dependencies.extensions) return reply.code(501).send({ error: "Extension Host is not configured" });
    try {
      const deleted = await dependencies.extensions.deleteEnvSimPersona(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "Persona not found" });
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
  // 模型目录：registry（api/manual/builtin 三向合并）缺省时回退静态档案
  const catalog = (): Array<ModelProfile | CatalogModel> =>
    dependencies.models?.list() ?? listModelProfiles().map((profile) => ({ ...profile, source: "builtin" as const }));
  const profileOf = (model: string, provider?: string): ModelProfile => dependencies.models?.get(model, provider) ?? getModelProfile(model);
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
    const refreshed = dependencies.providerProfilesRuntime
      ? await dependencies.providerProfilesRuntime.refreshModels()
      : await models.refresh({ providers: [] });
    const url = config.models?.catalogSyncUrl;
    if (!url) return refreshed;
    return { ...refreshed, catalogSync: await models.syncCatalogFromUrl(url) };
  });
  app.put<{ Params: { id: string }; Body: Partial<CatalogModel> & { originalProvider?: string } }>("/api/models/:id", async (request, reply) => {
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
        && typeof value.imageOutput === "boolean" && typeof value.tools === "boolean"
        && (value.reasoningContent === undefined || typeof value.reasoningContent === "boolean");
      if (!valid) return reply.code(400).send({ error: "capabilities must include modalities/thinking/effort arrays plus imageOutput and tools booleans (reasoningContent optional boolean)" });
      const inRange = value.modalities.every((item) => MODEL_MODALITIES.includes(item as ModelModality))
        && value.thinking.every((item) => THINKING_MODES.includes(item as ThinkingMode))
        && value.effort.every((item) => EFFORT_LEVELS.includes(item as EffortLevel));
      if (!inRange) return reply.code(400).send({ error: "capabilities values out of range (modalities: text/image/video; thinking: adaptive/enabled/disabled; effort: low/medium/high/xhigh/max/ultra)" });
    }
    for (const key of ["contextWindow", "maxOutput"] as const) {
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1)) {
        return reply.code(400).send({ error: `${key} must be a positive integer` });
      }
    }
    // 已知模型沿用现有档案为底，未知模型经元数据库成档（保守默认）
    const originalProvider = typeof body.originalProvider === "string" ? body.originalProvider : undefined;
    const candidates = models.list().filter((entry) => entry.id === id);
    const known = originalProvider
      ? candidates.find((entry) => entry.provider === originalProvider)
      : body.provider
        ? candidates.find((entry) => entry.provider === body.provider)
        : candidates.length === 1 ? candidates[0] : undefined;
    if (!originalProvider && body.provider === undefined && candidates.length > 1) {
      return reply.code(400).send({ error: "provider is required because this model ID exists under multiple providers" });
    }
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
    if (known?.source === "manual" && known.provider !== model.provider) await models.removeManual(id, known.provider);
    await models.upsertManual(model);
    // Return the registry-normalized representation rather than echoing the
    // request body. This keeps the public capability contract closed (for
    // example, an unsupported videoOutput field is never reflected back).
    return { ...models.get(id, model.provider), source: "manual" as const };
  });
  app.delete<{ Params: { id: string }; Querystring: { provider?: string } }>("/api/models/:id", async (request, reply) => {
    const models = dependencies.models;
    if (!models) return reply.code(501).send({ error: "Model registry is not configured" });
    const provider = request.query.provider;
    const matches = models.list().filter((item) => item.id === request.params.id && item.source === "manual");
    if (!provider && matches.length > 1) return reply.code(400).send({ error: "provider is required because this model ID exists under multiple providers" });
    const selected = provider ?? matches[0]?.provider;
    if (!selected || !models.isManual(request.params.id, selected)) return reply.code(409).send({ error: "Only manual models can be deleted" });
    await models.removeManual(request.params.id, selected);
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
    if (config.snapshotBackend && !updated.workspace) {
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
    if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd) {
      return reply.code(400).send({ error: "cwd must be a non-empty string" });
    }
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
    // Linux 直接模式：core 支持 overlay 时自动升级为 overlayfs 托管会话（见上注释）
    if (platform === "linux" && await tryCreateOverlayfsSession(request.body, provider, model, reply)) return;
    const session = await applySessionDefaults(await sessions.create({ ...request.body, provider, model }), provider, model);
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
    const profile = profileOf(model, provider);
    const thinkingExplicit = Boolean(request.body && Object.prototype.hasOwnProperty.call(request.body, "thinking"));
    const effortExplicit = Boolean(request.body && Object.prototype.hasOwnProperty.call(request.body, "effort"));
    const requestedThinking = thinkingExplicit ? request.body.thinking ?? undefined : session.thinking;
    const requestedEffort = effortExplicit ? request.body.effort ?? undefined : session.effort;
    // 能力数组为空 = 未声明：放行全部合法枚举（新模型默认支持思考，UI 全开可选）；
    // 数组非空 = 已声明：维持白名单 400。非法枚举值一律 400。
    const thinkingDeclared = profile.capabilities.thinking.length > 0;
    const effortDeclared = profile.capabilities.effort.length > 0;
    if (requestedThinking !== undefined && !THINKING_MODES.includes(requestedThinking)) {
      return reply.code(400).send({ error: `Unknown thinking mode ${requestedThinking}` });
    }
    if (requestedEffort !== undefined && !EFFORT_LEVELS.includes(requestedEffort)) {
      return reply.code(400).send({ error: `Unknown effort level ${requestedEffort}` });
    }
    if (thinkingExplicit && requestedThinking !== undefined && thinkingDeclared && !profile.capabilities.thinking.includes(requestedThinking)) {
      return reply.code(400).send({ error: `Model ${model} does not support thinking mode ${requestedThinking}` });
    }
    if (effortExplicit && requestedEffort !== undefined && effortDeclared && !profile.capabilities.effort.includes(requestedEffort)) {
      return reply.code(400).send({ error: `Model ${model} does not support effort ${requestedEffort}` });
    }
    // A model/provider switch is atomic from the UI's perspective.  Preserve
    // compatible inherited reasoning settings, and automatically clear stale
    // values that the target profile cannot accept.  Explicit invalid values
    // remain a 400 above so callers still receive useful validation feedback.
    // 未声明（空数组）视为全部兼容，继承值保留。
    const thinking = requestedThinking !== undefined && (!thinkingDeclared || profile.capabilities.thinking.includes(requestedThinking))
      ? requestedThinking
      : undefined;
    const effort = requestedEffort !== undefined && (!effortDeclared || profile.capabilities.effort.includes(requestedEffort))
      ? requestedEffort
      : undefined;
    const agentMode = request.body && "agentMode" in request.body ? request.body.agentMode ?? undefined : session.agentMode;
    if (agentMode !== undefined && !["plan", "code", "goal"].includes(agentMode)) {
      return reply.code(400).send({ error: 'agentMode must be "plan", "code", or "goal"' });
    }
    const snapshotMode = request.body && "snapshotMode" in request.body ? request.body.snapshotMode ?? undefined : session.snapshotMode;
    if (snapshotMode !== undefined && !["auto", "manual"].includes(snapshotMode)) {
      return reply.code(400).send({ error: 'snapshotMode must be "auto" or "manual"' });
    }
    const shellBackend = request.body && "shellBackend" in request.body ? request.body.shellBackend ?? undefined : session.shellBackend;
    if (shellBackend !== undefined && !["default", "pwsh", "bash", "cmd"].includes(shellBackend)) {
      return reply.code(400).send({ error: 'shellBackend must be "default", "pwsh", "bash", or "cmd"' });
    }
    const pythonEnv = request.body && "pythonEnv" in request.body ? request.body.pythonEnv ?? undefined : session.pythonEnv;
    if (pythonEnv !== undefined && !["global", "uv-workspace", "uv-config"].includes(pythonEnv)) {
      return reply.code(400).send({ error: 'pythonEnv must be "global", "uv-workspace", or "uv-config"' });
    }
    const nodeEnv = request.body && "nodeEnv" in request.body ? request.body.nodeEnv ?? undefined : session.nodeEnv;
    if (nodeEnv !== undefined && !["global", "project", "fnm", "nvm"].includes(nodeEnv)) {
      return reply.code(400).send({ error: 'nodeEnv must be "global", "project", "fnm", or "nvm"' });
    }
    // env-sim 人格预设（会话级覆盖）：空串清除；非空必须是已知预设 id（扩展宿主不可用时只做类型校验）
    const persona = request.body && "persona" in request.body ? request.body.persona ?? undefined : session.persona;
    if (persona !== undefined) {
      if (typeof persona !== "string") return reply.code(400).send({ error: "persona must be a string" });
      const trimmed = persona.trim();
      if (trimmed && dependencies.extensions) {
        const known = (await dependencies.extensions.listEnvSimPersonas()).personas;
        if (!known.some((item) => item.id === trimmed)) return reply.code(400).send({ error: `unknown persona "${trimmed}"` });
      }
    }
    // 并行子代理开关：布尔校验；显式 false 与未设置等价（关闭）
    const swarmEnabled = request.body && "swarmEnabled" in request.body ? request.body.swarmEnabled ?? undefined : session.swarmEnabled;
    if (swarmEnabled !== undefined && typeof swarmEnabled !== "boolean") {
      return reply.code(400).send({ error: "swarmEnabled must be a boolean" });
    }
    // 会话级工具白名单/黑名单：缺省保持不变；null 或空数组清除；未知名静默忽略（过滤时无效果）
    const toolsAllow = request.body && "toolsAllow" in request.body ? request.body.toolsAllow ?? undefined : session.toolsAllow;
    const toolsAllowError = validateToolNameList(toolsAllow, "toolsAllow");
    if (toolsAllowError) return reply.code(400).send({ error: toolsAllowError });
    const toolsDeny = request.body && "toolsDeny" in request.body ? request.body.toolsDeny ?? undefined : session.toolsDeny;
    const toolsDenyError = validateToolNameList(toolsDeny, "toolsDeny");
    if (toolsDenyError) return reply.code(400).send({ error: toolsDenyError });
    // 备选模型链：缺省保持不变；null 或空数组清除；按生效主模型归一化（去重/剔除同主模型项）
    const fallbackModelsRaw = request.body && "fallbackModels" in request.body ? request.body.fallbackModels ?? undefined : session.fallbackModels;
    const fallbackResult = normalizeFallbackModels(fallbackModelsRaw, { provider, model });
    if (fallbackResult.error) return reply.code(400).send({ error: fallbackResult.error });
    const fallbackModels = fallbackResult.entries;
    // 会话级扩展状态补丁：key 必须是已安装的扩展 id，value 为 JSON 对象（整体替换）或 null（清除）
    const extensionState = request.body && "extensionState" in request.body ? request.body.extensionState : undefined;
    if (extensionState !== undefined) {
      if (!extensionState || typeof extensionState !== "object" || Array.isArray(extensionState)) {
        return reply.code(400).send({ error: "extensionState must be an object keyed by extension id" });
      }
      for (const [extensionId, value] of Object.entries(extensionState)) {
        if (!dependencies.extensions?.hasExtension(extensionId)) return reply.code(400).send({ error: `unknown extension "${extensionId}"` });
        if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) {
          return reply.code(400).send({ error: `extensionState["${extensionId}"] must be a JSON object or null` });
        }
      }
    }
    const permissionMode = request.body?.permissionMode ?? session.permissionMode ?? "ask";
    if (!["ask", "acceptEdits", "review", "yolo"].includes(permissionMode)) return reply.code(400).send({ error: "permissionMode must be ask, acceptEdits, review, or yolo" });
    // review 模式的审核模型来源：仅显式提供时更新（无清除语义）
    const reviewModel = request.body && "reviewModel" in request.body ? request.body.reviewModel ?? undefined : session.reviewModel;
    if (reviewModel !== undefined && !["fast", "main"].includes(reviewModel)) {
      return reply.code(400).send({ error: 'reviewModel must be "fast" or "main"' });
    }
    const touchesSandbox = Boolean(request.body && ("sandboxMode" in request.body || "setupScript" in request.body));
    if (touchesSandbox) {
      const sandboxModeError = validateSandboxMode(request.body?.sandboxMode);
      if (sandboxModeError) return reply.code(400).send({ error: sandboxModeError });
      if (request.body?.setupScript !== undefined && typeof request.body.setupScript !== "string") {
        return reply.code(400).send({ error: "setupScript must be a string" });
      }
    }
    // 网络策略补丁独立于 sandboxMode（network-only 更新不清除既有 sandboxMode）
    const sandboxNetwork = request.body?.network;
    if (sandboxNetwork !== undefined) {
      const networkError = validateSandboxNetwork(sandboxNetwork);
      if (networkError) return reply.code(400).send({ error: networkError });
    }
    // filtered 依赖同 AppContainer 包内 sidecar 代理，wsb 模式下无此形态，组合拒绝
    const effectiveSandboxMode = request.body?.sandboxMode ?? session.sandboxMode;
    const effectiveNetwork = sandboxNetwork ?? session.sandbox?.network;
    if (effectiveNetwork === "filtered" && effectiveSandboxMode === "wsb") {
      return reply.code(400).send({ error: "network filtered 不支持 wsb 沙盒模式" });
    }
    if ((touchesSandbox || sandboxNetwork !== undefined) && session.sandboxMode === "wsb") {
      // WSB 的启动脚本/模式/网络只在虚拟机启动时生效，切换前先释放旧实例。
      await core.release?.(session.id);
    }
    await sessions.updateConfig(request.params.id, { provider, model, ...(thinking ? { thinking } : {}), ...(effort ? { effort } : {}), ...(agentMode ? { agentMode } : {}), ...(snapshotMode ? { snapshotMode } : {}), ...(shellBackend ? { shellBackend } : {}), ...(pythonEnv ? { pythonEnv } : {}), ...(nodeEnv ? { nodeEnv } : {}), ...(persona !== undefined ? { persona: persona.trim() } : {}), ...(swarmEnabled === true ? { swarmEnabled: true } : {}), ...(reviewModel ? { reviewModel } : {}), ...(toolsAllow?.length ? { toolsAllow } : {}), ...(toolsDeny?.length ? { toolsDeny } : {}), ...(fallbackModels?.length ? { fallbackModels } : {}) });
    let updated = await sessions.updatePermissions(request.params.id, permissionMode, session.permissionRules ?? []);
    if (extensionState !== undefined) {
      updated = await sessions.updateExtensionState(request.params.id, extensionState);
    }
    if (touchesSandbox) {
      updated = await sessions.updateSandboxMode(request.params.id, request.body?.sandboxMode, request.body?.setupScript);
      configuredSessions.delete(session.id);
    }
    if (sandboxNetwork !== undefined) {
      updated = await sessions.updateSandboxNetwork(request.params.id, sandboxNetwork);
      configuredSessions.delete(session.id);
    }
    events.publish({ source: "session", type: "session.config_updated", sessionId: session.id, payload: updated });
    return updated;
  });

  /** 会话执行级别透出：最近一次 configureSession 时 core 上报的 sandboxCapability/sandboxReason；无记录返回空对象。 */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/sandbox-status", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const status = core.sandboxStatusFor?.(request.params.id);
    if (!status) return {};
    return { sandboxCapability: status.capability, ...(status.reason !== undefined ? { sandboxReason: status.reason } : {}) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/context", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    const selection = { pins: session.contextPins ?? [], excludes: session.contextExcludes ?? [] };
    const view = await manager.buildView(session.messages, { selection });
    const prefs = getPreferences();
    return { ...view, selection, preferences: { language: prefs.language, currency: prefs.currency, currencyLabel: prefs.currency === "CNY" ? "RMB" : "USD" } };
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
        return reply.code(400).send({ error: errorMessage(error) });
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
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.put<{ Params: { id: string }; Body: { pins?: string[]; excludes?: string[] } }>("/api/sessions/:id/context/selection", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update context selection when it is idle" });
    try {
      const meta = await sessions.updateContextSelection(request.params.id, { pins: request.body?.pins, excludes: request.body?.excludes });
      const selection = { pins: meta.contextPins ?? [], excludes: meta.contextExcludes ?? [] };
      events.publish({ source: "session", type: "context.selection_updated", sessionId: request.params.id, payload: selection });
      return selection;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.put<{ Params: { id: string }; Body: { enabled?: boolean; budget?: number | null } }>("/api/sessions/:id/context/repo-map", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update repo map settings when it is idle" });
    if (request.body?.enabled !== undefined && typeof request.body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    if (request.body?.budget !== undefined && request.body.budget !== null && (!Number.isSafeInteger(request.body.budget) || request.body.budget < 64 || request.body.budget > 100_000)) {
      return reply.code(400).send({ error: "budget must be an integer between 64 and 100000, or null" });
    }
    try {
      const meta = await sessions.updateRepoMapSettings(request.params.id, {
        enabled: request.body?.enabled,
        budget: request.body?.budget ?? undefined,
      });
      const settings = { enabled: meta.repoMapEnabled !== false, budget: meta.repoMapBudget ?? 2048 };
      events.publish({ source: "session", type: "context.repo_map_updated", sessionId: request.params.id, payload: settings });
      return settings;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  // ---- 符号索引（0.4.0 Phase 2 §7.2）：状态 / 显式重建（job，可取消）/ 符号查询 ----
  // 索引只是加速缓存：未建或损坏时 symbols 查询返回 409 并引导显式重建，绝不自动触发。
  const requireIndexManager = (): IndexManager | undefined => dependencies.indexManager;
  app.get<{ Querystring: { sessionId?: string } }>("/api/workspaces/index/status", async (request, reply) => {
    const indexManager = requireIndexManager();
    if (!indexManager) return reply.code(501).send({ error: "Symbol index is not enabled" });
    const sessionId = request.query.sessionId;
    if (!sessionId) return reply.code(400).send({ error: "sessionId query parameter is required" });
    const session = await sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return indexManager.status(sessionId, session.cwd);
  });
  app.post<{ Body: { sessionId?: string } }>("/api/workspaces/index/rebuild", async (request, reply) => {
    const indexManager = requireIndexManager();
    if (!indexManager) return reply.code(501).send({ error: "Symbol index is not enabled" });
    const sessionId = request.body?.sessionId;
    if (!sessionId) return reply.code(400).send({ error: "sessionId is required" });
    const session = await sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    try {
      const { jobId } = await indexManager.rebuild(sessionId, session.cwd);
      return reply.code(202).send({ accepted: true, jobId });
    } catch (error) {
      if (error instanceof IndexBuildingError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Body: { sessionId?: string } }>("/api/workspaces/index/rebuild/cancel", async (request, reply) => {
    const indexManager = requireIndexManager();
    if (!indexManager) return reply.code(501).send({ error: "Symbol index is not enabled" });
    const sessionId = request.body?.sessionId;
    if (!sessionId) return reply.code(400).send({ error: "sessionId is required" });
    const session = await sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const cancelled = await indexManager.cancel(sessionId, session.cwd);
    if (!cancelled) return reply.code(409).send({ error: "No index rebuild is running for this workspace" });
    return { accepted: true };
  });
  app.get<{ Querystring: { sessionId?: string; q?: string; kind?: string; limit?: string; file?: string } }>("/api/workspaces/symbols", async (request, reply) => {
    const indexManager = requireIndexManager();
    if (!indexManager) return reply.code(501).send({ error: "Symbol index is not enabled" });
    const sessionId = request.query.sessionId;
    if (!sessionId) return reply.code(400).send({ error: "sessionId query parameter is required" });
    const session = await sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const query = request.query.q?.trim() ?? "";
    const kind = request.query.kind?.trim() || undefined;
    const file = request.query.file?.trim() || undefined;
    const parsedLimit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)) {
      return reply.code(400).send({ error: "limit must be an integer between 1 and 200" });
    }
    try {
      // file 参数（编辑器面包屑，0.5.0 Phase 1a）：按文件精确取符号，与 q 互斥、优先生效
      const symbols = file
        ? await indexManager.symbolsInFile(session.cwd, file)
        : query
          ? await indexManager.searchSymbols(session.cwd, query, { ...(kind ? { kind } : {}), ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}) })
          : [];
      const status = await indexManager.status(sessionId, session.cwd);
      return { symbols, indexStatus: status.status };
    } catch (error) {
      if (error instanceof IndexUnavailableError) return reply.code(409).send({ error: error.message, code: error.code });
      throw error;
    }
  });
  // @ 文件补全供数（0.4.0 Phase 2 §5.2）：索引文件清单搜索；与 complete-path 实时 glob 互补，
  // 索引未建/损坏时 409 INDEX_UNAVAILABLE，前端据此回退 complete-path，用户无感。
  app.get<{ Querystring: { sessionId?: string; q?: string; limit?: string } }>("/api/workspaces/files", async (request, reply) => {
    const indexManager = requireIndexManager();
    if (!indexManager) return reply.code(501).send({ error: "Symbol index is not enabled" });
    const sessionId = request.query.sessionId;
    if (!sessionId) return reply.code(400).send({ error: "sessionId query parameter is required" });
    const session = await sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const query = request.query.q?.trim() ?? "";
    const parsedLimit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)) {
      return reply.code(400).send({ error: "limit must be an integer between 1 and 200" });
    }
    try {
      const files = query
        ? await indexManager.searchFiles(session.cwd, query, { ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}) })
        : [];
      const status = await indexManager.status(sessionId, session.cwd);
      return { files, indexStatus: status.status };
    } catch (error) {
      if (error instanceof IndexUnavailableError) return reply.code(409).send({ error: error.message, code: error.code });
      throw error;
    }
  });
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

  // 上下文压缩（§7.4）：/compact（overview）、/compact tools（toolcalls），以及协议 REST 路由
  const runCompact = async (sessionId: string, mode: "toolcalls" | "overview") => {
    // compact-vault 官方扩展启用时，压缩走档案库路径（归档完整上下文 + 目录索引 + 按需召回）；
    // mode 参数不适用（vault 固定归档整理语义），提示词覆盖同样不适用（vault 自带整理提示词）
    if (dependencies.vaultService && dependencies.extensions?.isEnabled("compact-vault")) {
      const config = dependencies.extensions.list().find((item) => item.id === "compact-vault")?.config ?? {};
      const vaultResult = await dependencies.vaultService.compact(sessionId, {
        ...(Number.isSafeInteger(config.keepTail) ? { keepTail: config.keepTail as number } : {}),
        ...(Number.isSafeInteger(config.chunkSize) ? { chunkSize: config.chunkSize as number } : {}),
      });
      if (vaultResult.changed) {
        events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: vaultResult.mode, uptoIndex: vaultResult.uptoIndex ?? 0, forced: false } });
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

  // ---- 评测 harness（0.5.0 Phase 3a）----
  app.get("/api/eval/tasks", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { tasks: dependencies.evalEvaluator.listTasks() };
  });
  app.post<{ Body: { taskIds?: string[] } }>("/api/eval/run", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const taskIds = Array.isArray(request.body?.taskIds) ? request.body.taskIds.filter((id): id is string => typeof id === "string") : undefined;
    try {
      const report = await dependencies.evalEvaluator.runTasks(taskIds);
      return reply.code(200).send(report);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get<{ Params: { runId: string } }>("/api/eval/runs/:runId", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const report = await dependencies.evalEvaluator.getRun(request.params.runId);
    if (!report) return reply.code(404).send({ error: "Run not found" });
    return report;
  });
  app.get("/api/eval/runs", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { runs: await dependencies.evalEvaluator.listRuns() };
  });
  app.post<{ Body: { baselineRunId?: string; candidateRunId?: string } }>("/api/eval/compare", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const baseline = request.body?.baselineRunId;
    const candidate = request.body?.candidateRunId;
    if (!baseline || !candidate || baseline === candidate) return reply.code(400).send({ error: "baseline and candidate must be different eval run IDs" });
    const comparison = await dependencies.evalEvaluator.compareRuns(baseline, candidate);
    if (!comparison) return reply.code(404).send({ error: "Evaluation run not found" });
    return comparison;
  });
  app.get("/api/eval/comparisons", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { comparisons: await dependencies.evalEvaluator.listComparisons() };
  });
  app.get<{ Params: { comparisonId: string } }>("/api/eval/comparisons/:comparisonId", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const comparison = await dependencies.evalEvaluator.getComparison(request.params.comparisonId);
    if (!comparison) return reply.code(404).send({ error: "Comparison not found" });
    return comparison;
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
