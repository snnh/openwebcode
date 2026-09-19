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
import {
  DSH_EVENTS_RESULT,
  DSH_MUX_PATH,
  encodeUnaryError,
  encodeUnaryValue,
  parseUnaryRequest,
  wireError,
  type DshMuxOutboundFrame,
} from "./wire.js";
import { DshMuxSession, type DshMuxChannel } from "./mux.js";
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
  /** 运行期开关（`dshCompatEnabled`）：关闭时 API 与 index 一律 503。 */
  enabled: () => boolean;
  /** owc 访问令牌（未设置时端口只允许回环访问，与主端口语义一致）。 */
  accessToken: string | undefined;
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

  const app = Fastify({ logger: false, bodyLimit: 300 * 1024 * 1024 });
  await app.register(websocket);

  const bridge = new DshEventBridge(options.deps);
  const unary = buildUnaryHandlers(options.deps);
  const streams = buildStreamHandlers(options.deps, bridge);

  /** 关闭态统一语义：503 + 明确理由（不假装 404，避免前端误判为版本不匹配）。 */
  const disabled = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown =>
    reply.code(503).send({ error: "dsh 兼容模式未启用（dshCompatEnabled=false）" });

  const authorized = (request: FastifyRequest): boolean => {
    if (options.accessToken === undefined) return true;
    const cookies = parseCookies(request.headers.cookie ?? "");
    const cookieToken = cookies.get(ACCESS_COOKIE);
    if (cookieToken !== undefined && safeTokenEqual(options.accessToken, cookieToken)) return true;
    const header = request.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    return bearer !== undefined && safeTokenEqual(options.accessToken, bearer);
  };

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    // 静态资源与插件 bundle 公开（与 dsh 一致：不含会话数据）
    if (pathname.startsWith("/assets/") || pathname.startsWith("/plugins/")) return;
    if (pathname === "/favicon.svg" || pathname === "/manifest.webmanifest") return;
    // `/?token=...` 换成 HttpOnly cookie（与主 SPA 同一 cookie 名，两个端口共用）
    const queryToken = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>).token : undefined;
    if (request.method === "GET" && pathname === "/" && typeof queryToken === "string" && options.accessToken !== undefined && safeTokenEqual(options.accessToken, queryToken)) {
      reply.header("set-cookie", `${ACCESS_COOKIE}=${encodeURIComponent(options.accessToken)}; HttpOnly; SameSite=Strict; Path=/`);
      // dsh 用 303（token 换 cookie 后必须走 GET，避免携带凭据的二次提交）
      return reply.redirect("/", 303);
    }
    if (authorized(request)) return;
    return reply.code(401).send({ error: "Authentication required" });
  });

  app.get("/", async (_request, reply) => {
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
    // 与 dsh 一致：鉴权/开关在升级前拒绝（401/503），不做「先升级再关」
    preValidation: async (request, reply) => {
      if (!options.enabled()) return reply.code(503).send({ error: "dsh 兼容模式未启用（dshCompatEnabled=false）" });
      if (!authorized(request)) return reply.code(401).send({ error: "Authentication required" });
      return undefined;
    },
  }, (socket) => {
    // WS 适配：JSON 文本帧 ↔ mux 帧；二进制直接交给 mux 判 1003
    const channel: DshMuxChannel = {
      send: (frame: DshMuxOutboundFrame) => socket.send(JSON.stringify(frame)),
      close: (code, reason) => socket.close(code, reason),
    };
    const session = new DshMuxSession(channel, (endpoint) => streams.get(endpoint));
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

