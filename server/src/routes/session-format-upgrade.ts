import type { FastifyInstance } from "fastify";
import { errorMessage } from "../error-utils.js";
import {
  isSessionUpgrading, listFormatUpgrades, upgradeAllSessions, upgradeSessionFormat,
} from "../extensions/session-format-upgrade.js";
import type { RouteContext } from "./route-context.js";

/**
 * 会话格式升级路由（扩展 session-format-upgrade）：
 * - 扩展未启用时全部 503（与 owc-eval 同模式）；
 * - GET 列表：发现已注册升级步骤（未来其他部分注册的步骤同样在此列出）；
 * - 单会话触发要求会话离线（agent.isRunning 为 false），否则 409；
 * - 触发即锁：升级期间（同步执行）该会话不可使用（messages/retry 入口 409）；
 * - body.stepId 可选：指定执行单个升级步骤，缺省执行全部已注册步骤。
 */
export function registerSessionFormatUpgradeRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies, sessions, agent } = ctx;

  app.get("/api/sessions/format-upgrades", async (_request, reply) => {
    if (!dependencies.extensions?.isEnabled("session-format-upgrade")) {
      return reply.code(503).send({ error: "session-format-upgrade extension is disabled" });
    }
    return { steps: listFormatUpgrades() };
  });

  app.post<{ Params: { id: string }; Body: { stepId?: string } }>("/api/sessions/:id/format-upgrade", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("session-format-upgrade")) {
      return reply.code(503).send({ error: "session-format-upgrade extension is disabled" });
    }
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; stop it before upgrading" });
    if (isSessionUpgrading(request.params.id)) return reply.code(409).send({ error: "Session format upgrade is already in progress" });
    const stepId = typeof request.body?.stepId === "string" && request.body.stepId.trim() ? request.body.stepId : undefined;
    try {
      return await upgradeSessionFormat(sessions, request.params.id, stepId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { stepId?: string } }>("/api/sessions/format-upgrade-all", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("session-format-upgrade")) {
      return reply.code(503).send({ error: "session-format-upgrade extension is disabled" });
    }
    const stepId = typeof request.body?.stepId === "string" && request.body.stepId.trim() ? request.body.stepId : undefined;
    try {
      return await upgradeAllSessions(sessions, (id) => agent.isRunning(id), stepId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}
