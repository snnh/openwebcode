import type { FastifyInstance } from "fastify";
import { isLoopbackOrLAN } from "../auth-totp.js";
import type { RouteContext } from "./route-context.js";

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { totp, listenHost, totpGateEnabled, totpAuthenticated, bearerAuthorized, totpTicketOf, totpCookieHeader } = ctx;


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
}
