import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { detectWsb } from "../sandbox/wsb.js";
import { SettingsValidationError } from "../settings-service.js";
import { errorMessage } from "../error-utils.js";
import type { ExecRequest } from "../core-client.js";
import { loadPromptOverride, loadScopedPromptOverride, writeGlobalPromptOverride, writeProjectPromptOverride, type PromptOverrideWriteBody } from "../agent/prompts/prompt-overrides.js";
import { INIT_COMMAND_PROMPT } from "../agent/prompts/init-prompt.js";
import { PI_BASE_SYSTEM_PROMPT, PI_PROMPT_VERSION } from "../agent/prompts/pi-base.js";
import { COMPACT_OVERVIEW_SYSTEM, COMPACT_TOOLCALLS_SYSTEM } from "../context/compactor.js";
import { applyCacheSavings } from "../usage-log.js";
import type { RouteContext } from "./route-context.js";

export function registerMiscRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions } = dependencies;
  const { getPreferences, managedSyncingSessions, managedCheckpointingSessions, acquireManagedWorkspaceUse } = ctx;

  /** 项目作用域写入的 cwd 必须是一个已存在会话的工作目录（防任意路径写）。 */
  const isKnownSessionCwd = async (cwd: string): Promise<boolean> => {
    // 内存 cwd 集（SessionStore 维护，create/delete/import 同步），不再每次全量 list()
    return sessions.hasSessionCwd(cwd);
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


  // ── 目录浏览（新建会话对话框） ──────────────────────────────────────────
  // browseRoots：可配置浏览根（OWC_BROWSE_ROOTS / server-settings.json），空则回退家目录
  const browseRoots: string[] = (() => {
    const fromSettings = dependencies.settings?.effective().browseRoots;
    return fromSettings?.length ? fromSettings.map((r: string) => path.resolve(r)) : [path.resolve(homedir())];
  })();
  app.get("/api/browse/roots", async () => ({ roots: browseRoots }));

  app.get<{ Querystring: { path?: string } }>("/api/browse", async (request, reply) => {
    const raw = request.query.path;
    if (!raw) return reply.code(400).send({ error: "missing 'path' query parameter" });
    const target = path.resolve(raw);

    // 安全校验：target 必须是某个 browseRoot 自身或其子路径
    const isWithinRoot = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);
    const root = browseRoots.find((r) => isWithinRoot(target, r));
    if (!root) return reply.code(403).send({ error: "path is outside of browse roots" });

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return reply.code(404).send({ error: "path not found" });
      if (code === "EACCES") return reply.code(403).send({ error: "permission denied" });
      return reply.code(500).send({ error: "failed to read directory" });
    }

    // parent：上一级路径（仅在仍在某 browseRoot 内时返回，否则 null 防越界上溯）
    const parentDir = path.dirname(target);
    const parent = browseRoots.some((r) => isWithinRoot(parentDir, r)) && parentDir !== target ? parentDir : null;

    // 列表项：目录在前、文件在后；跳过隐藏文件（. 开头）减少噪声
    const items = entries
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isDir: d.isDirectory(), isSymlink: d.isSymbolicLink() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

    return { path: target, parent, entries: items };
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


  app.get("/api/skills", async () => {
    const skills = dependencies.skills ? await dependencies.skills.listFor(undefined) : [];
    return { skills: skills.map(({ name, description, source, path: filePath }) => ({ name, description, source, path: filePath })) };
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
    // 缓存节省估算在报表缓存之外后处理：定价目录/汇率编辑即时生效
    const enriched = applyCacheSavings(
      report,
      (provider, model) => ctx.pricing.get(provider, model),
      ctx.exchangeRates?.current(),
    );
    // 会话可能已删除：title 查不到时缺省，前端回退为短 id
    const titles = new Map((await sessions.list()).map((item) => [item.id, item.title]));
    return {
      ...enriched,
      sessions: enriched.sessions.map((row) => ({ ...row, title: titles.get(row.sessionId) })),
      preferences: { currency: getPreferences().currency },
    };
  });
}
