import type { FastifyInstance } from "fastify";
import { buildAccessUrls } from "../access-token.js";
import { getServerVersion, GITHUB_REPO } from "../version.js";
import { UpdateApplyError } from "../update-applier.js";
import { errorMessage } from "../error-utils.js";
import { maskAccessToken } from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerSystemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, events } = dependencies;
  const { auth, listenHost, clients, wsStats } = ctx;

  app.get("/api/health", async () => ({ status: "ok" }));


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

  app.get("/api/metrics", async () => ({ events: events.stats(), websocket: { clients: clients.size, slowClientDisconnects: wsStats.slowClientDisconnects, failedClientSends: wsStats.failedClientSends } }));
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
    // 手动「立即检查」不受 updateCheckEnabled（周期开关）限制
    const snapshot = await checker.refresh(true);
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
}
