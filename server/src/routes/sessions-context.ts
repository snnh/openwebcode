import type { FastifyInstance } from "fastify";
import { ContextManager, type BudgetUpdate } from "../context/context-manager.js";
import type { Currency } from "../context/model-profile.js";
import { parseDecimalToScaled } from "../cost/exchange-rate.js";
import type { IndexManager } from "../index/index-manager.js";
import { updateEvictionPolicy, type ContextPolicyUpdate } from "../extensions/context-saver/index.js";
import { IndexBuildingError, IndexUnavailableError } from "../index/index-manager.js";
import { errorMessage } from "../error-utils.js";
import {
  THINKING_MODES, EFFORT_LEVELS,
  type SessionConfigBody, type BudgetBody,
} from "./route-context.js";
import type { RouteContext } from "./route-context.js";

export function registerSessionContextRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;
  const { core, sessions, agent, events, providers } = dependencies;
  const {
    profileOf, getPreferences, configuredSessions,
    validateSandboxMode, validateSandboxNetwork, validateToolNameList, normalizeFallbackModels,
  } = ctx;


  app.get<{ Params: { id: string } }>("/api/sessions/:id/skills", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const skills = dependencies.skills ? await dependencies.skills.listFor(session.cwd) : [];
    return { skills: skills.map(({ name, description, source }) => ({ name, description, source })) };
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
    // nodeEnv 变化会改变与选择绑定的沙盒工具链挂载（readOnlyPaths）：下次工具调用需重新 configure
    if (nodeEnv !== session.nodeEnv) configuredSessions.delete(session.id);
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
    // 选择性上下文是 context-saver 扩展能力：扩展关闭时与 agent 循环一致传空（面板数据 = 实际注入）
    const saverOn = !dependencies.extensions || dependencies.extensions.isEnabled("context-saver");
    const selection = saverOn
      ? { pins: session.contextPins ?? [], excludes: session.contextExcludes ?? [] }
      : { pins: [] as string[], excludes: [] as string[] };
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
    // 驱逐策略是 context-saver 扩展能力：宿主存在且扩展被禁用时拒绝（宿主缺省按默认开启处理，与 agent 循环一致）
    if (dependencies.extensions && !dependencies.extensions.isEnabled("context-saver")) return reply.code(409).send({ error: "context-saver extension is disabled" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update context policy when it is idle" });
    try {
      const manager = new ContextManager(sessions.contextRoot(request.params.id));
      const ledger = await updateEvictionPolicy(manager, request.body ?? {});
      events.publish({ source: "session", type: "context.policy_updated", sessionId: request.params.id, payload: ledger.policy });
      return ledger;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.put<{ Params: { id: string }; Body: { pins?: string[]; excludes?: string[] } }>("/api/sessions/:id/context/selection", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    // 选择性上下文（pin/排除）是 context-saver 扩展能力：扩展禁用时拒绝
    if (dependencies.extensions && !dependencies.extensions.isEnabled("context-saver")) return reply.code(409).send({ error: "context-saver extension is disabled" });
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
      const settings = { enabled: meta.repoMapEnabled === true, budget: meta.repoMapBudget ?? 2048 };
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
}
