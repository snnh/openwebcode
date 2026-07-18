import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { SteeringError } from "./agent/agent-runner.js";
import { CoreRpcError } from "./core-client.js";
import { ContextManager } from "./context/context-manager.js";
import { getModelProfile, listModelProfiles } from "./context/model-profile.js";
import { lookupModelMetadata } from "./context/model-metadata.js";
import { PricingValidationError } from "./cost/pricing-catalog.js";
import { parseDecimalToScaled } from "./cost/exchange-rate.js";
import { detectWsb } from "./sandbox/wsb.js";
import { getSnapshotBackend } from "./snapshots/index.js";
import { SessionTransferError } from "./sessions/session-transfer.js";
import { SettingsValidationError } from "./settings-service.js";
function serializePricing(pricing) {
    return {
        currency: pricing.currency,
        input: pricing.input.toString(),
        output: pricing.output.toString(),
        cacheRead: pricing.cacheRead.toString(),
        cacheWrite: pricing.cacheWrite.toString(),
    };
}
export async function buildServer(dependencies) {
    const { core, sessions, agent, events, providers, pricing } = dependencies;
    const defaultCurrency = dependencies.defaultCurrency ?? "CNY";
    const defaultLanguage = dependencies.defaultLanguage ?? "zh-CN";
    const getPreferences = dependencies.getPreferences ?? (() => ({ currency: defaultCurrency, language: defaultLanguage }));
    const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
    // 会话导入走 ndjson/纯文本原文，不经 JSON 解析
    app.addContentTypeParser(["application/x-ndjson", "text/plain"], { parseAs: "string" }, (_request, body, done) => done(null, body));
    await app.register(websocket);
    if (dependencies.webDist && existsSync(dependencies.webDist)) {
        await app.register(fastifyStatic, { root: dependencies.webDist, prefix: "/" });
    }
    const clients = new Set();
    // 已向 core 配置过 sandbox 的会话，避免文件浏览每次重配与 agent 运行竞态
    const configuredSessions = new Set();
    const defaultSandbox = (cwd) => ({
        enabled: true,
        readRoots: [cwd],
        writeRoots: [cwd],
        denyPaths: [path.join(cwd, ".env")],
        network: "allow",
    });
    const SANDBOX_MODES = ["appcontainer", "wsb", "jobobject", "off"];
    /** 返回错误文案；合法或缺省返回 undefined。wsb 需本机 capability 可用 */
    const validateSandboxMode = (value) => {
        if (value === undefined)
            return undefined;
        if (typeof value !== "string" || !SANDBOX_MODES.includes(value))
            return "sandboxMode must be appcontainer, wsb, jobobject, or off";
        if (value === "wsb") {
            const wsb = detectWsb();
            if (!wsb.available)
                return `sandboxMode wsb 不可用：${wsb.reason ?? "Windows Sandbox 不可用"}`;
        }
        return undefined;
    };
    events.on("event", (event) => {
        const serialized = JSON.stringify(event);
        for (const client of clients) {
            if (client.readyState === 1 && (!client.sessionId || !event.sessionId || client.sessionId === event.sessionId))
                client.send(serialized);
        }
    });
    app.get("/api/health", async () => ({ status: "ok" }));
    app.get("/api/core", async () => core.ping());
    app.get("/api/sandbox/capabilities", async () => ({ appcontainer: true, jobobject: true, off: true, wsb: detectWsb() }));
    app.get("/api/managed-workspace/capability", async (_request, reply) => {
        const managed = dependencies.managed;
        if (!managed)
            return reply.code(501).send({ error: "Managed workspace is not configured" });
        return managed.capability();
    });
    app.get("/api/providers", async () => providers.list());
    // 模型目录：registry（api/manual/builtin 三向合并）缺省时回退静态档案
    const catalog = () => dependencies.models?.list() ?? listModelProfiles().map((profile) => ({ ...profile, source: "builtin" }));
    const profileOf = (model) => dependencies.models?.get(model) ?? getModelProfile(model);
    app.get("/api/models", async () => catalog().map((profile) => ({
        ...profile,
        ...(pricing.get(profile.provider, profile.id) ? {
            pricing: serializePricing(pricing.get(profile.provider, profile.id)),
        } : {}),
    })));
    app.post("/api/models/refresh", async (request, reply) => {
        const models = dependencies.models;
        if (!models)
            return reply.code(501).send({ error: "Model registry is not configured" });
        const config = dependencies.settings?.effective() ?? {};
        return models.refresh({ ...(config.anthropic ? { anthropic: config.anthropic } : {}), ...(config.openai ? { openai: config.openai } : {}) });
    });
    app.put("/api/models/:id", async (request, reply) => {
        const models = dependencies.models;
        if (!models)
            return reply.code(501).send({ error: "Model registry is not configured" });
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
                && typeof value.tools === "boolean";
            if (!valid)
                return reply.code(400).send({ error: "capabilities must include modalities/thinking/effort arrays and a tools boolean" });
        }
        for (const key of ["contextWindow", "maxOutput"]) {
            if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) {
                return reply.code(400).send({ error: `${key} must be a positive integer` });
            }
        }
        // 已知模型沿用现有档案为底，未知模型经元数据库成档（保守默认）
        const known = models.list().find((entry) => entry.id === id);
        if (!known && body.provider === undefined) {
            return reply.code(400).send({ error: "provider is required for a new model" });
        }
        const metadata = lookupModelMetadata(id);
        const base = known ?? {
            id,
            provider: "manual",
            source: "api",
            contextWindow: metadata.contextWindow,
            maxOutput: metadata.maxOutput,
            capabilities: metadata.capabilities,
        };
        const displayName = body.displayName ?? base.displayName;
        const model = {
            ...base,
            provider: body.provider ?? base.provider,
            source: "manual",
            ...(displayName ? { displayName } : {}),
            contextWindow: body.contextWindow ?? base.contextWindow,
            maxOutput: body.maxOutput ?? base.maxOutput,
            capabilities: body.capabilities ?? base.capabilities,
        };
        await models.upsertManual(model);
        return model;
    });
    app.delete("/api/models/:id", async (request, reply) => {
        const models = dependencies.models;
        if (!models)
            return reply.code(501).send({ error: "Model registry is not configured" });
        if (!models.isManual(request.params.id))
            return reply.code(409).send({ error: "Only manual models can be deleted" });
        await models.removeManual(request.params.id);
        return reply.code(204).send();
    });
    app.get("/api/model-pricing", async () => pricing.list());
    app.put("/api/model-pricing", async (request, reply) => {
        try {
            const document = await pricing.replace(request.body);
            events.publish({
                source: "server",
                type: "model.pricing_updated",
                payload: { version: document.version, updatedAt: document.updatedAt, entries: document.entries.length },
            });
            return document;
        }
        catch (error) {
            return reply.code(error instanceof PricingValidationError ? 400 : 500).send({
                error: error instanceof PricingValidationError
                    ? error.message
                    : "Failed to persist model pricing",
            });
        }
    });
    app.post("/api/exec", async (request) => core.run(request.body));
    if (dependencies.settings) {
        const settings = dependencies.settings;
        app.get("/api/settings", async () => settings.view());
        app.put("/api/settings", async (request, reply) => {
            try {
                return await settings.update(request.body?.overrides ?? {});
            }
            catch (error) {
                if (error instanceof SettingsValidationError)
                    return reply.code(400).send({ error: error.message });
                request.log.error(error, "Failed to persist server settings");
                return reply.code(500).send({ error: "Failed to persist server settings" });
            }
        });
    }
    /** 托管工作区创建：能力检测 → 预分配 id 建盘挂载复制 → 落 meta（cwd=挂载点、snapshotBackend 预设）；失败清理半成品 */
    const createManagedSession = async (body, provider, reply) => {
        const managed = dependencies.managed;
        if (!managed)
            return reply.code(501).send({ error: "Managed workspace is not configured" });
        const capability = await managed.capability();
        const candidate = capability.backends.find((item) => item.available);
        if (!candidate) {
            const reasons = capability.backends.map((item) => item.detail).filter(Boolean).join("；");
            return reply.code(400).send({ error: `托管工作区不可用${reasons ? `：${reasons}` : "（当前平台不支持）"}` });
        }
        // 源目录必须存在（要复制进镜像）；直接模式不校验 cwd 的行为保持不变
        const origin = await stat(body.cwd).catch(() => undefined);
        if (!origin?.isDirectory())
            return reply.code(400).send({ error: `源目录不存在或不是目录：${body.cwd}` });
        const sessionId = randomUUID();
        let provisioned;
        try {
            provisioned = await managed.provision({ sessionId, originCwd: body.cwd, backend: candidate.backend });
        }
        catch (error) {
            return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
        }
        const workspace = {
            mode: "managed",
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
                id: sessionId,
                cwd: provisioned.mountPoint,
                workspace,
                snapshotBackend: `${provisioned.backend}-chain`,
            });
            events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
            return reply.code(201).send(session);
        }
        catch (error) {
            await managed.teardown({ id: sessionId, workspace }).catch(() => undefined);
            throw error;
        }
    };
    app.post("/api/sessions", async (request, reply) => {
        if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd) {
            return reply.code(400).send({ error: "cwd must be a non-empty string" });
        }
        const provider = request.body.provider ?? "development";
        if (!providers.get(provider)) {
            return reply.code(400).send({ error: `Provider ${provider} is not configured` });
        }
        const sandboxModeError = validateSandboxMode(request.body.sandboxMode);
        if (sandboxModeError)
            return reply.code(400).send({ error: sandboxModeError });
        if (request.body.setupScript !== undefined && typeof request.body.setupScript !== "string") {
            return reply.code(400).send({ error: "setupScript must be a string" });
        }
        if (request.body.workspaceMode !== undefined && request.body.workspaceMode !== "managed") {
            return reply.code(400).send({ error: 'workspaceMode must be "managed"' });
        }
        if (request.body.workspaceMode === "managed")
            return createManagedSession(request.body, provider, reply);
        const session = await sessions.create({ ...request.body, provider });
        events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
        return reply.code(201).send(session);
    });
    app.get("/api/sessions", async () => sessions.list());
    app.get("/api/sessions/:id", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        return session;
    });
    app.get("/api/sessions/:id/export", async (request, reply) => {
        const jsonl = await sessions.exportJsonl(request.params.id);
        if (jsonl === undefined)
            return reply.code(404).send({ error: "Session not found" });
        return reply
            .header("content-type", "application/x-ndjson; charset=utf-8")
            .header("content-disposition", `attachment; filename="session-${request.params.id}.jsonl"`)
            .send(jsonl);
    });
    app.post("/api/sessions/import", { bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
        if (typeof request.body !== "string" || request.body.trim() === "") {
            return reply.code(400).send({ error: "JSONL body is required" });
        }
        try {
            const meta = await sessions.importJsonl(request.body);
            events.publish({ source: "session", type: "session.created", sessionId: meta.id, payload: meta });
            return reply.code(201).send(meta);
        }
        catch (error) {
            if (error instanceof SessionTransferError)
                return reply.code(400).send({ error: error.message });
            throw error;
        }
    });
    app.get("/api/skills", async () => {
        const skills = dependencies.skills ? await dependencies.skills.listFor(undefined) : [];
        return { skills: skills.map(({ name, description, source, path: filePath }) => ({ name, description, source, path: filePath })) };
    });
    app.get("/api/sessions/:id/skills", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        const skills = dependencies.skills ? await dependencies.skills.listFor(session.cwd) : [];
        return { skills: skills.map(({ name, description, source }) => ({ name, description, source })) };
    });
    app.get("/api/reports/cost", async (request, reply) => {
        if (!dependencies.usageLog)
            return reply.code(404).send({ error: "Usage log not enabled" });
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
    app.put("/api/sessions/:id/config", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(request.params.id))
            return reply.code(409).send({ error: "Session is running; update its config when it is idle" });
        const provider = request.body?.provider ?? session.provider;
        const model = request.body?.model ?? session.model;
        if (!providers.get(provider))
            return reply.code(400).send({ error: `Provider ${provider} is not configured` });
        if (typeof model !== "string" || !model)
            return reply.code(400).send({ error: "model must be a non-empty string" });
        const profile = profileOf(model);
        const thinking = request.body && "thinking" in request.body ? request.body.thinking ?? undefined : session.thinking;
        const effort = request.body && "effort" in request.body ? request.body.effort ?? undefined : session.effort;
        if (thinking !== undefined && !profile.capabilities.thinking.includes(thinking)) {
            return reply.code(400).send({ error: `Model ${model} does not support thinking mode ${thinking}` });
        }
        if (effort !== undefined && !profile.capabilities.effort.includes(effort)) {
            return reply.code(400).send({ error: `Model ${model} does not support effort ${effort}` });
        }
        const permissionMode = request.body?.permissionMode ?? session.permissionMode ?? "ask";
        if (!["ask", "acceptEdits", "yolo"].includes(permissionMode))
            return reply.code(400).send({ error: "permissionMode must be ask, acceptEdits, or yolo" });
        const touchesSandbox = Boolean(request.body && ("sandboxMode" in request.body || "setupScript" in request.body));
        if (touchesSandbox) {
            const sandboxModeError = validateSandboxMode(request.body?.sandboxMode);
            if (sandboxModeError)
                return reply.code(400).send({ error: sandboxModeError });
            if (request.body?.setupScript !== undefined && typeof request.body.setupScript !== "string") {
                return reply.code(400).send({ error: "setupScript must be a string" });
            }
        }
        await sessions.updateConfig(request.params.id, { provider, model, ...(thinking ? { thinking } : {}), ...(effort ? { effort } : {}) });
        let updated = await sessions.updatePermissions(request.params.id, permissionMode, session.permissionRules ?? []);
        if (touchesSandbox) {
            updated = await sessions.updateSandboxMode(request.params.id, request.body?.sandboxMode, request.body?.setupScript);
        }
        events.publish({ source: "session", type: "session.config_updated", sessionId: session.id, payload: updated });
        return updated;
    });
    app.get("/api/sessions/:id/context", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        const manager = new ContextManager(sessions.contextRoot(request.params.id));
        const view = await manager.buildView(session.messages);
        const prefs = getPreferences();
        return { ...view, preferences: { language: prefs.language, currency: prefs.currency, currencyLabel: prefs.currency === "CNY" ? "RMB" : "USD" } };
    });
    app.put("/api/sessions/:id/context/budget", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(request.params.id)) {
            return reply.code(409).send({ error: "Session is running; update its budget when it is idle" });
        }
        const tokenValue = request.body?.maxSessionTokens;
        if (tokenValue !== null && tokenValue !== undefined && (!Number.isSafeInteger(tokenValue) || tokenValue < 1)) {
            return reply.code(400).send({ error: "maxSessionTokens must be a positive integer or null" });
        }
        let costValue;
        const requestedCost = request.body?.maxSessionCost;
        if (requestedCost !== null && requestedCost !== undefined) {
            const requestedCurrency = requestedCost.currency === "RMB" ? "CNY" : requestedCost.currency ?? getPreferences().currency;
            if (!requestedCost || typeof requestedCost.amount !== "string" || !["USD", "CNY"].includes(requestedCurrency)) {
                return reply.code(400).send({ error: "maxSessionCost must contain amount string and optional USD, CNY, or RMB currency, or null" });
            }
            try {
                costValue = {
                    currency: requestedCurrency,
                    microUnits: parseDecimalToScaled(requestedCost.amount, 1000000n).toString(),
                };
            }
            catch (error) {
                return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
            }
        }
        const manager = new ContextManager(sessions.contextRoot(request.params.id));
        const update = {};
        if (request.body && "maxSessionTokens" in request.body)
            update.maxSessionTokens = tokenValue ?? undefined;
        if (request.body && "maxSessionCost" in request.body)
            update.maxSessionCost = costValue;
        const ledger = await manager.updateBudget(update);
        events.publish({ source: "session", type: "context.budget_updated", sessionId: request.params.id, payload: await manager.budgetStatus() });
        return ledger;
    });
    app.post("/api/sessions/:id/context/restore", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
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
        }
        catch (error) {
            return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get("/api/sessions/:id/files", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        // 仅在 idle 且尚未配置时配置一次；运行中复用 agent 已配置的状态，避免竞态
        if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
            await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
            configuredSessions.add(session.id);
        }
        return core.listFiles({ sessionId: request.params.id, path: request.query.path || "." });
    });
    app.get("/api/sessions/:id/files/content", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        if (!request.query.path)
            return reply.code(400).send({ error: "path is required" });
        if (!agent.isRunning(session.id) && !configuredSessions.has(session.id)) {
            await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? defaultSandbox(session.cwd) });
            configuredSessions.add(session.id);
        }
        return core.readFile({ sessionId: request.params.id, path: request.query.path });
    });
    app.get("/api/sessions/:id/checkpoints/:checkpointId/diff", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        const backend = await getSnapshotBackend(sessions, session);
        return { diff: await backend.diff(request.params.checkpointId) };
    });
    app.get("/api/sessions/:id/snapshot-capability", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        return (await getSnapshotBackend(sessions, session)).capability();
    });
    app.get("/api/sessions/:id/checkpoints", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        return (await getSnapshotBackend(sessions, session)).list();
    });
    app.post("/api/sessions/:id/checkpoints", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(session.id))
            return reply.code(409).send({ error: "Session is running" });
        const label = request.body?.label ?? "Manual checkpoint";
        if (typeof label !== "string" || !label.trim())
            return reply.code(400).send({ error: "label must be a non-empty string" });
        const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
        const backend = await getSnapshotBackend(sessions, session);
        const checkpoint = await backend.create(label, session.messages.length, ledger);
        events.publish({ source: "session", type: "checkpoint.created", sessionId: session.id, payload: checkpoint });
        return reply.code(201).send(checkpoint);
    });
    app.post("/api/sessions/:id/checkpoints/:checkpointId/restore", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(session.id))
            return reply.code(409).send({ error: "Session is running" });
        if (request.body?.confirm !== true)
            return reply.code(400).send({ error: "confirm must be true" });
        const backend = await getSnapshotBackend(sessions, session);
        const checkpoint = (await backend.list()).find((item) => item.id === request.params.checkpointId);
        if (!checkpoint)
            return reply.code(404).send({ error: "Checkpoint not found" });
        await backend.restore(checkpoint.id);
        if (!request.body?.filesOnly) {
            await sessions.truncateMessages(session.id, checkpoint.messageCount);
            await new ContextManager(sessions.contextRoot(session.id)).replaceLedger(checkpoint.ledger);
        }
        events.publish({ source: "session", type: "checkpoint.restored", sessionId: session.id, payload: { id: checkpoint.id, filesOnly: request.body?.filesOnly === true } });
        return checkpoint;
    });
    app.delete("/api/sessions/:id/checkpoints/:checkpointId", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(session.id))
            return reply.code(409).send({ error: "Session is running" });
        const backend = await getSnapshotBackend(sessions, session);
        await backend.delete(request.params.checkpointId);
        events.publish({ source: "session", type: "checkpoint.deleted", sessionId: session.id, payload: { id: request.params.checkpointId } });
        return reply.code(204).send();
    });
    app.delete("/api/sessions/:id", async (request, reply) => {
        if (agent.isRunning(request.params.id)) {
            return reply.code(409).send({ error: "Session is running; abort it before deletion" });
        }
        const detail = await sessions.get(request.params.id);
        if (!detail)
            return reply.code(404).send({ error: "Session not found" });
        await core.cleanupSession(request.params.id).catch(() => undefined);
        // 释放会话持有的沙盒 core（WSB 虚拟机蒸发）；裸 CoreClient 无 release，为 no-op
        await core.release?.(request.params.id).catch(() => undefined);
        // 托管工作区：先卸载镜像盘再删目录（失败仅记日志，残留挂载由启动孤儿扫描兜底）
        if (detail.workspace?.mode === "managed" && dependencies.managed) {
            await dependencies.managed.teardown(detail).catch((error) => request.log.error(error, "Managed workspace teardown failed"));
        }
        if (!(await sessions.delete(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        return reply.code(204).send();
    });
    // 上下文压缩（§7.4）：/compact（overview）、/compact tools（toolcalls），以及协议 REST 路由
    const runCompact = async (sessionId, mode) => {
        const result = await dependencies.compactor.compact(sessionId, mode);
        if (result.changed) {
            events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: result.mode, uptoIndex: result.uptoIndex ?? 0, forced: false } });
        }
        return result;
    };
    const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const MAX_IMAGES_PER_MESSAGE = 4;
    const MAX_IMAGE_BASE64 = 7_000_000; // base64 字符数，约等于 5MB 原始字节
    const isValidImage = (image) => {
        if (!image || typeof image !== "object")
            return false;
        const record = image;
        return typeof record.mediaType === "string" && IMAGE_MEDIA_TYPES.has(record.mediaType) &&
            typeof record.data === "string" && record.data.length > 0 && record.data.length <= MAX_IMAGE_BASE64 &&
            /^[A-Za-z0-9+/=]+$/.test(record.data);
    };
    app.post("/api/sessions/:id/compact", async (request, reply) => {
        if (!dependencies.compactor)
            return reply.code(503).send({ error: "Compactor not enabled" });
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(request.params.id))
            return reply.code(409).send({ error: "Session is running" });
        const mode = request.body?.mode === "toolcalls" ? "toolcalls" : "overview";
        try {
            return await runCompact(request.params.id, mode);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post("/api/sessions/:id/messages", { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
        if (!request.body || typeof request.body.content !== "string" || !request.body.content) {
            return reply.code(400).send({ error: "content must be a non-empty string" });
        }
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
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
        const compactCommand = request.body.content.match(/^\/compact(?:\s+(tools?|toolcalls))?\s*$/i);
        if (compactCommand) {
            if (!dependencies.compactor)
                return reply.code(503).send({ error: "压缩器未启用" });
            if (agent.isRunning(request.params.id))
                return reply.code(409).send({ error: "会话运行中，请先等待完成或中断后再压缩" });
            try {
                const result = await runCompact(request.params.id, compactCommand[1] ? "toolcalls" : "overview");
                return reply.code(200).send({ accepted: true, compacted: result.changed, result });
            }
            catch (error) {
                return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
            }
        }
        if (agent.isRunning(request.params.id)) {
            try {
                const queued = agent.enqueueSteering(request.params.id, request.body.content);
                return reply.code(202).send({ accepted: true, queued: true, ...queued });
            }
            catch (error) {
                const code = error instanceof SteeringError
                    ? (error.code === "full" ? 429 : error.code === "too_long" ? 413 : 409)
                    : 409;
                return reply.code(code).send({ error: error instanceof Error ? error.message : String(error) });
            }
        }
        const budget = await new ContextManager(sessions.contextRoot(request.params.id)).budgetStatus();
        if (budget.paused) {
            return reply.code(409).send({
                error: budget.cost.paused ? "Session cost budget is exhausted or unavailable" : "Session token budget is exhausted",
                budget,
            });
        }
        void agent.run(request.params.id, request.body.content, { ...(images?.length ? { images } : {}) }).catch(() => undefined);
        return reply.code(202).send({ accepted: true });
    });
    app.get("/api/sessions/:id/permissions", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        // 待确认权限走 REST 可恢复：刷新或重连后 WS 补发可能已越过 permission.request 事件
        return agent.listPendingPermissions(request.params.id);
    });
    app.post("/api/sessions/:id/permissions/respond", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        const body = request.body;
        if (!body || typeof body.requestId !== "string" || !["allow", "allow_always", "deny"].includes(body.decision) || (body.reason !== undefined && typeof body.reason !== "string")) {
            return reply.code(400).send({ error: "requestId, decision allow|allow_always|deny, and optional reason are required" });
        }
        if (!(await agent.respondPermission(request.params.id, body.requestId, body.decision, body.reason)))
            return reply.code(404).send({ error: "Permission request not found" });
        return { accepted: true };
    });
    app.get("/api/sessions/:id/steering", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        return agent.listSteering(request.params.id);
    });
    app.delete("/api/sessions/:id/steering/:steeringId", async (request, reply) => {
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        if (!agent.removeSteering(request.params.id, request.params.steeringId))
            return reply.code(404).send({ error: "Steering item not found" });
        return reply.code(204).send();
    });
    app.post("/api/sessions/:id/abort", async (request, reply) => {
        if (!agent.abort(request.params.id))
            return reply.code(409).send({ error: "Session is not running" });
        return reply.code(202).send({ accepted: true });
    });
    app.get("/api/events", { websocket: true }, (socket, request) => {
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
                ...(sessionId ? { sessionId } : {}),
                payload: { after, latestSeq: replay.latestSeq },
            }));
        }
        else {
            for (const event of replay.events)
                socket.send(JSON.stringify(event));
        }
        const client = {
            get readyState() { return socket.readyState; },
            send: (data) => socket.send(data),
            ...(sessionId ? { sessionId } : {}),
        };
        clients.add(client);
        socket.send(JSON.stringify({ source: "server", type: "connected", seq: replay.latestSeq, createdAt: new Date().toISOString(), payload: { latestSeq: replay.latestSeq } }));
        socket.on("close", () => clients.delete(client));
    });
    app.setErrorHandler((error, _request, reply) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        let code = 500;
        if (normalized instanceof CoreRpcError) {
            if (normalized.code === -32602 || normalized.code === -32600)
                code = 400;
            else if (normalized.code === -32003)
                code = 404;
            else if (normalized.code === -32002)
                code = 403;
            else if (normalized.code === -32001)
                code = 504;
            else
                code = 502;
        }
        else if (normalized.message === "Invalid session ID") {
            code = 400;
        }
        else if ("code" in normalized && normalized.code === "FST_ERR_VALIDATION") {
            code = 400;
        }
        reply.code(code).send({ error: normalized.message });
    });
    return app;
}
