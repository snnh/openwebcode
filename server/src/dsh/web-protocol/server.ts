/**
 * dsh 兼容模式独立端口服务（M4 步骤 15）。
 *
 * 该 origin 的根布局由本层掌管（与 owc 主端口完全隔离）：
 *   GET  /                         自渲染 index（注入 boot graph；需鉴权）
 *   GET  /assets/**                 vendored 前端静态资源（公开）
 *   GET  /plugins/<id>/<file>?rev=  client 插件 bundle（公开）
 *   POST /api/<ns>/<method>         Typert Remote unary（需鉴权）
 *   GET  /api/remote.mux            WebSocket 逻辑流复用（需鉴权）
 *
 * 鉴权复用 owc 访问令牌：同一 host 下主 SPA 的 `?token=` 已下发 HttpOnly cookie，
 * dsh 端口读同一 cookie（也可直接用 `/?token=` 自行换 cookie，与主 SPA 行为一致）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { parseCookies, safeTokenEqual } from "../../routes/route-context.js";
import { isLoopbackHost } from "../../config.js";
import { DEFAULT_WS_BACKPRESSURE_LIMITS } from "../../events/ws-backpressure.js";
import {
  DSH_EVENTS_RESULT,
  DSH_MUX_PATH,
  encodeUnaryError,
  encodeUnaryValue,
  parseUnaryRequest,
  wireError,
  type DshMuxOutboundFrame,
} from "./wire.js";
import { DshMuxSession } from "./mux.js";
import {
  bootInjections,
  buildBootGraph,
  loadVendorManifest,
  renderIndexInjections,
  type DshVendorManifest,
  type DshVendorPlugin,
} from "./boot-graph.js";
import { DshEventBridge, buildStreamHandlers, buildUnaryHandlers, type DshWireDeps } from "./streams.js";

/** 访问令牌 cookie 名（与主 SPA 一致）。 */
const ACCESS_COOKIE = "owc_access_token";

/** 心跳：Host Ping 间隔与容忍的连续未回次数（与 dsh 一致）。 */
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_MISSES = 2;

export interface DshServerOptions {
  /** vendor 目录（`scripts/fetch-dsh-web.mjs` 产出）。 */
  vendorDirectory: string;
  /** 运行期开关（`dshCompatEnabled`）：关闭时该独立端口上的 API 与 index 一律 503。 */
  enabled: () => boolean;
  /**
   * owc 访问令牌（**请求期取值**：令牌轮换后新令牌立即生效、旧令牌同步失效；
   * 运行期在 build 时快照会让轮换后两端不一致）。未设置时端口只允许回环访问，
   * 且按主端口语义强制回环 Host 头（防 DNS rebinding）。
   */
  accessToken: () => string | undefined;
  /** 非回环监听（有令牌）时的浏览器来源白名单（与主端口 `auth.allowedOrigins` 同口径；缺省仅放行与 Host 同源的来源）。 */
  allowedOrigins?: readonly string[];
  /** TOTP 全局登录门禁（与主端口同一 TotpAuthService；启用时无有效票据的请求一律 401）。 */
  totp?: { enabled(): boolean; validateTicket(ticket: string | undefined): boolean };
  deps: DshWireDeps;
  /** 随 owc 发布注入的 bridge 插件（步骤 18）；缺省则只跑 dsh 官方 roster。 */
  bridgePlugin?: DshVendorPlugin;
  /** 桥接插件产物目录（默认与 vendor 同级：`<assets>/dsh-bridge`）。 */
  bridgeDirectory?: string;
  /**
   * `/dsh-owc/status` 的响应体构造（拿到真实 owc 版本/端口后由 runtime 注入）。
   * `context.cookieAuthenticated` 由本层按请求 cookie 判定，供实现决定回跳 URL 是否还需带令牌参数。
   */
  owcStatus?: (context: { cookieAuthenticated: boolean }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  logger: { warn(message: string): void; info(message: string): void };
}

export interface DshServer {
  app: FastifyInstance;
  manifest: DshVendorManifest;
  /** 启动监听。 */
  listen(host: string, port: number): Promise<string>;
  close(): Promise<void>;
}

/** 读 vendor 清单并构建 dsh 端口服务；vendor 缺失返回 undefined（调用方按「未安装 dsh UI」如实提示）。 */
export async function buildDshServer(options: DshServerOptions): Promise<DshServer | undefined> {
  const manifest = await loadVendorManifest(options.vendorDirectory);
  if (manifest === undefined) return undefined;
  const plugins = options.bridgePlugin === undefined ? manifest.plugins : [...manifest.plugins, options.bridgePlugin];
  const graph = buildBootGraph(plugins);
  const staticRoot = path.join(options.vendorDirectory, "static");
  const indexHtml = await readFile(path.join(staticRoot, "index.html"), "utf8").catch(() => undefined);
  const injectionRows = bootInjections(graph);
  const renderedIndex = indexHtml === undefined ? undefined : renderIndexInjections(indexHtml, injectionRows);

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(websocket);

  const bridge = new DshEventBridge(options.deps);
  const unary = buildUnaryHandlers(options.deps);
  const streams = buildStreamHandlers(options.deps, bridge);

  /**
   * 关闭态统一语义：503 + 明确理由（不假装 404，避免前端误判为版本不匹配）。
   * 关闭态的正常表现是「端口根本不监听」（连接被拒）；这个分支覆盖的是关闭瞬间的窗口——
   * 设置已落盘、`sync()` 还没关掉监听，此时端口上的请求必须被明确拒绝而不是照常服务。
   */
  const disabled = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown =>
    reply.code(503).send({ error: "dsh 兼容模式未启用（dshCompatEnabled=false）" });

  /** 令牌鉴权（cookie / bearer，请求期取令牌）。 */
  const authorized = (request: FastifyRequest): boolean => {
    const token = options.accessToken();
    if (token === undefined) return true;
    const cookies = parseCookies(request.headers.cookie ?? "");
    const cookieToken = cookies.get(ACCESS_COOKIE);
    if (cookieToken !== undefined && safeTokenEqual(token, cookieToken)) return true;
    const header = request.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    return bearer !== undefined && safeTokenEqual(token, bearer);
  };

  /** TOTP 第二因子（启用时要求有效票据；bearer 令牌本身已过令牌鉴权，与主端口口径一致）。 */
  const totpAuthenticated = (request: FastifyRequest): boolean => {
    if (options.totp === undefined || !options.totp.enabled()) return true;
    return options.totp.validateTicket(parseCookies(request.headers.cookie ?? "").get("owc_totp_session"));
  };

  /**
   * 无认证（回环监听、未设令牌）模式的 Host 校验：仅接受回环 Host，挡住 DNS rebinding 之类
   * 经非本机 Host 的请求（与主端口 `hostAllowed` 同语义；WS 升级在 preValidation 里再查 Origin）。
   */
  const hostAllowed = (host: string | string[] | undefined): boolean => {
    if (options.accessToken() !== undefined) return true;
    const value = Array.isArray(host) ? host[0] : host;
    if (typeof value !== "string" || value === "") return false;
    const hostname = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0] ?? "";
    return isLoopbackHost(hostname);
  };

  /** WS 升级的 Origin 校验：无令牌模式要求回环来源（防跨站 WS）；有令牌模式按白名单/同源放行。 */
  const originAllowed = (origin: string | undefined, hostHeader: string | string[] | undefined): boolean => {
    if (origin === undefined) return true; // 非浏览器客户端（CLI 等）
    try {
      const parsed = new URL(origin);
      if (options.accessToken() === undefined) {
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
      }
      if (options.allowedOrigins?.includes(origin)) return true;
      const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
      return typeof host === "string" && parsed.host === host;
    } catch {
      return false;
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    // 先规范化再判公开前缀：原始 url 可能是百分号编码/含点段的形式（纵深防御，路由层另有白名单）
    let pathname = request.url.split("?", 1)[0] ?? "";
    try {
      pathname = path.posix.normalize(decodeURIComponent(pathname));
    } catch {
      // 编码非法：保留原始串，下面的前缀判定不命中即走鉴权，路由层会 404
    }
    const upgrade = Array.isArray(request.headers.upgrade) ? request.headers.upgrade[0] : request.headers.upgrade;
    if (upgrade?.toLowerCase() !== "websocket" && !hostAllowed(request.headers.host)) {
      return reply.code(403).send({ error: "Loopback mode requires a loopback Host header" });
    }
    // 静态资源与插件 bundle 公开（与 dsh 一致：不含会话数据）
    if (pathname.startsWith("/assets/") || pathname.startsWith("/plugins/")) return;
    if (pathname === "/favicon.svg" || pathname === "/manifest.webmanifest") return;
    // `/?token=...` 换成 HttpOnly cookie（与主 SPA 同一 cookie 名，两个端口共用）
    const queryToken = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>).token : undefined;
    const currentToken = options.accessToken();
    if (request.method === "GET" && pathname === "/" && typeof queryToken === "string" && currentToken !== undefined && safeTokenEqual(currentToken, queryToken)) {
      reply.header("set-cookie", `${ACCESS_COOKIE}=${encodeURIComponent(currentToken)}; HttpOnly; SameSite=Strict; Path=/`);
      // dsh 用 303（token 换 cookie 后必须走 GET，避免携带凭据的二次提交）
      return reply.redirect("/", 303);
    }
    if (authorized(request) && totpAuthenticated(request)) return;
    return reply.code(401).send({ error: "Authentication required" });
  });

  // 公开可执行 JS 至少带上 nosniff（与主端口安全头同口径；index 内联脚本需保留 unsafe-inline，不加 CSP）
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/", async (_request, reply) => {
    if (!options.enabled()) return disabled(reply);
    if (renderedIndex === undefined) return reply.code(503).send({ error: "dsh UI 静态资源不完整（vendor/static/index.html 缺失）" });
    return reply.type("text/html; charset=utf-8").send(renderedIndex);
  });

  // 显式 /index.html 也走自渲染（静态插件 index:false 只挡目录索引，不挡显式文件名；
  // 关闭态必须 503 而不是把未注入 boot graph 的原始 index 交出去）
  app.get("/index.html", async (_request, reply) => {
    if (!options.enabled()) return disabled(reply);
    if (renderedIndex === undefined) return reply.code(503).send({ error: "dsh UI 静态资源不完整（vendor/static/index.html 缺失）" });
    return reply.type("text/html; charset=utf-8").send(renderedIndex);
  });

  // 前端静态资源（不含 index，index 走上面的自渲染路由）
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/", index: false, decorateReply: false });

  /** 插件文件响应（含路径越界与 rev 校验）。 */
  const sendPluginFile = async (id: string, file: string, rev: string | undefined, reply: { code: (status: number) => { send: (body: unknown) => unknown } ; type: (value: string) => { send: (body: unknown) => unknown } }): Promise<unknown> => {
    const declared = plugins.find((plugin) => plugin.id === id);
    if (declared === undefined) return reply.code(404).send({ error: `未 vendored 的插件：${id}` });
    const normalized = path.posix.normalize(file);
    if (normalized.startsWith("..") || path.isAbsolute(normalized) || !declared.files.includes(normalized)) {
      return reply.code(404).send({ error: `插件文件不存在：${id}/${file}` });
    }
    if (rev !== undefined && rev !== declared.rev && rev !== "") {
      // rev 过期说明前端持有旧图：如实回 404 让它重新拉图
      return reply.code(404).send({ error: `rev 不匹配：${rev} ≠ ${declared.rev}` });
    }
    const pluginPath = declared.originDirectory === undefined
      ? path.join(options.vendorDirectory, "plugins", id, normalized)
      : path.join(declared.originDirectory, normalized);
    const body = await readFile(pluginPath).catch(() => undefined);
    if (body === undefined) return reply.code(404).send({ error: `插件文件读取失败：${id}/${normalized}` });
    return reply.type(normalized.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream").send(body);
  };

  // 插件 bundle：id 是 npm 包名（含 scope 的 `/`），故用通配路由，按最后一个 `/` 切分
  app.get<{ Querystring: { rev?: string } }>("/plugins/*", async (request, reply) => {
    const rest = (request.params as Record<string, string>)["*"] ?? "";
    const slash = rest.lastIndexOf("/");
    if (slash <= 0 || slash === rest.length - 1) return reply.code(404).send({ error: `插件路径不合法：${rest}` });
    return sendPluginFile(rest.slice(0, slash), rest.slice(slash + 1), request.query.rev, reply as never);
  });

  // 桥接插件同源端点：owc 事实（需鉴权；内容不含密钥，令牌仅用于回跳换 cookie）
  app.get("/dsh-owc/status", async (request, reply) => {
    if (!options.enabled()) return disabled(reply);
    const cookieAuthenticated = parseCookies(request.headers.cookie ?? "").get(ACCESS_COOKIE) !== undefined;
    const status = options.owcStatus === undefined ? {} : await options.owcStatus({ cookieAuthenticated });
    return reply.type("application/json; charset=utf-8").send({ dshVersion: manifest.dshVersion, ...status });
  });

  // `$events/result` 与普通 unary 共用派发路径（端点名里含 `$`，单独注册更清晰）
  const handleUnary = async (endpoint: string, rawBody: string): Promise<{ status: number; body: string }> => {
    if (!options.enabled()) return { status: 503, body: JSON.stringify({ error: "dsh 兼容模式未启用（dshCompatEnabled=false）" }) };
    const parsed = parseUnaryRequest(rawBody, endpoint);
    if ("error" in parsed) {
      const rpcId = parsed.rpcId ?? "unknown";
      return { status: 200, body: encodeUnaryError(rpcId, parsed.error) };
    }
    const { rpcId, args } = parsed.request;
    try {
      if (endpoint === DSH_EVENTS_RESULT) {
        const result = await bridge.resolveResult(args);
        return { status: 200, body: "error" in result ? encodeUnaryError(rpcId, result.error) : encodeUnaryValue(rpcId, result.value) };
      }
      const handler = unary.get(endpoint);
      if (handler === undefined) {
        return { status: 200, body: encodeUnaryError(rpcId, wireError("gateway/method-unavailable", `未实现端点：${endpoint}`, { endpoint })) };
      }
      const projected = await handler(args);
      return { status: 200, body: "error" in projected ? encodeUnaryError(rpcId, projected.error) : encodeUnaryValue(rpcId, projected.value) };
    } catch (error) {
      options.logger.warn(`dsh unary ${endpoint} 失败：${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: encodeUnaryError(rpcId, wireError("gateway/internal", error instanceof Error ? error.message : String(error), { endpoint })) };
    }
  };

  app.post<{ Params: { namespace: string; method: string } }>("/api/:namespace/:method", async (request, reply) => {
    const endpoint = `${request.params.namespace}/${request.params.method}`;
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const outcome = await handleUnary(endpoint, raw);
    if (outcome.status === 503) return reply.code(503).send(JSON.parse(outcome.body));
    return reply.type("application/json; charset=utf-8").send(outcome.body);
  });

  app.get(DSH_MUX_PATH, {
    websocket: true,
    // 与 dsh 一致：鉴权/开关在升级前拒绝（401/503），不做「先升级再关」；
    // 另加 Origin 校验（无令牌模式仅回环来源，防跨站 WS 劫持）
    preValidation: async (request, reply) => {
      if (!options.enabled()) return reply.code(503).send({ error: "dsh 兼容模式未启用（dshCompatEnabled=false）" });
      if (!authorized(request) || !totpAuthenticated(request)) return reply.code(401).send({ error: "Authentication required" });
      const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
      if (!originAllowed(origin, request.headers.host)) {
        return reply.code(403).send({ error: "Origin not allowed" });
      }
      return undefined;
    },
  }, (socket) => {
    // WS 适配：JSON 文本帧 ↔ mux 帧；二进制直接交给 mux 判 1003。
    // 背压：待发字节/条数任一超限（与主端口 DEFAULT_WS_BACKPRESSURE_LIMITS 同阈值）即判定慢客户端——
    // 释放全部逻辑流并以 1013 断开，避免单客户端把服务端打成无界缓冲。
    let pendingSends = 0;
    let slowClientClosed = false;
    const session = new DshMuxSession(
      {
        send: (frame: DshMuxOutboundFrame) => {
          if (slowClientClosed) return;
          if (socket.bufferedAmount > DEFAULT_WS_BACKPRESSURE_LIMITS.maxBufferedBytes || pendingSends > DEFAULT_WS_BACKPRESSURE_LIMITS.maxBufferedMessages) {
            slowClientClosed = true;
            session.dispose();
            socket.close(1013, "slow client");
            return;
          }
          pendingSends += 1;
          socket.send(JSON.stringify(frame), () => {
            pendingSends -= 1;
          });
        },
        close: (code, reason) => socket.close(code, reason),
      },
      (endpoint) => streams.get(endpoint),
    );
    let misses = 0;
    socket.on("pong", () => { misses = 0; });
    const heartbeat = setInterval(() => {
      if (misses >= HEARTBEAT_MISSES) {
        clearInterval(heartbeat);
        socket.terminate();
        return;
      }
      misses++;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) { session.handleBinary(); return; }
      session.handleText(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    });
    socket.on("close", () => {
      clearInterval(heartbeat);
      session.dispose();
    });
  });

  const server: DshServer = {
    app,
    manifest,
    async listen(host: string, port: number): Promise<string> {
      await app.listen({ host, port });
      return app.server.address() !== null && typeof app.server.address() === "object"
        ? `${host}:${(app.server.address() as { port: number }).port}`
        : `${host}:${port}`;
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
  return server;
}

