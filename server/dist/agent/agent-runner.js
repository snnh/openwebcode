import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { estimateMessageTokens, getModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule } from "./permission-coordinator.js";
import { runSubAgent, SUB_AGENT_TOOL_NAMES } from "./sub-agent.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import { parseSkillCommand } from "../skills.js";
import { renderCommand } from "../commands.js";
import { appendMemory, readGlobalMemory, readProjectMemory } from "../memory.js";
import { webFetch } from "../web-tools.js";
const BASH_TOOL = {
    name: "bash",
    description: "Execute a shell command in the session workspace. Call this when command-line execution is required. " +
        "On Windows sandbox sessions commands run under cmd.exe: use cmd syntax (for example dir, type, where, and &&), " +
        "and do not use PowerShell cmdlets or POSIX commands unless explicitly invoking an available shell. " +
        "Set run_in_background=true to run the command asynchronously; the agent loop continues immediately and you can check " +
        "the result later with task_output (or wait with block=true).",
    inputSchema: {
        type: "object",
        properties: {
            cmd: { type: "string" },
            run_in_background: { type: "boolean", description: "Run the command in the background and return immediately." },
        },
        required: ["cmd"],
        additionalProperties: false,
    },
};
const READ_ARTIFACT_TOOL = {
    name: "read_artifact",
    description: "Read a bounded slice of a tool-output artifact when an evicted or truncated result points to an artifact ID.",
    inputSchema: {
        type: "object",
        properties: {
            artifactId: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
        },
        required: ["artifactId", "offset", "limit"],
        additionalProperties: false,
    },
};
const FILE_TOOLS = [
    { name: "read_file", description: "Read UTF-8 lines from a workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } },
    { name: "write_file", description: "Atomically write a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, createDirs: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } },
    { name: "edit_file", description: "Replace exact text in a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"], additionalProperties: false } },
    { name: "glob", description: "Recursively match workspace paths using * and ? wildcards.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
    { name: "grep", description: "Recursively search UTF-8 workspace files for literal text.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
];
const LOAD_SKILL_TOOL = {
    name: "load_skill",
    description: "Load the full text of a skill listed in the system prompt skill catalog.",
    inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
    },
};
const SPAWN_TASK_TOOL = {
    name: "spawn_task",
    description: "Launch a read-only sub-agent with an isolated context to explore or research a task. " +
        "The sub-agent does not share this session's context; only its final conclusion (at most 2000 characters) is returned. " +
        "It can only use the read-only tools read_file, glob, grep and read_artifact.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: { type: "string", description: "Self-contained task description for the sub-agent." },
            agent: { type: "string", description: "Optional custom sub-agent name from the system prompt catalog." },
            tools: {
                type: "array",
                items: { type: "string", enum: [...SUB_AGENT_TOOL_NAMES] },
                description: "Subset of read_file/glob/grep/read_artifact the sub-agent may use; defaults to all four.",
            },
        },
        required: ["prompt"],
        additionalProperties: false,
    },
};
const TODO_WRITE_TOOL = {
    name: "todo_write",
    description: "Replace the session task list. Use it to track multi-step work; keep exactly one item in_progress.",
    inputSchema: {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string" },
                        status: { type: "string", enum: ["pending", "in_progress", "done"] },
                        activeForm: { type: "string" },
                    },
                    required: ["content", "status"],
                    additionalProperties: false,
                },
            },
        },
        required: ["items"],
        additionalProperties: false,
    },
};
const REMEMBER_TOOL = {
    name: "remember",
    description: "Save a durable fact to long-term memory; remembered facts are injected into the system prompt on every turn. " +
        "Scope \"project\" (default) writes the workspace .owc/memory.md; scope \"global\" writes the server data-root memory.md shared by all sessions. " +
        "Use it for stable user preferences, project conventions, and key decisions worth keeping across compactions and sessions.",
    inputSchema: {
        type: "object",
        properties: {
            fact: { type: "string", description: "The fact to remember, stored as a single bullet." },
            scope: { type: "string", enum: ["project", "global"], description: "Where to store the fact; defaults to project." },
        },
        required: ["fact"],
        additionalProperties: false,
    },
};
const WEB_FETCH_TOOL = {
    name: "web_fetch",
    description: "Fetch a public http/https URL and return bounded readable text.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
};
const WEB_SEARCH_TOOL = {
    name: "web_search",
    description: "Search the web using the configured search provider.",
    inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
        required: ["query"],
        additionalProperties: false,
    },
};
const TASK_OUTPUT_TOOL = {
    name: "task_output",
    description: "Read the output of a background task started with bash run_in_background=true. " +
        "Set block=true to wait until the task finishes (up to timeoutMs, default 30s).",
    inputSchema: {
        type: "object",
        properties: {
            taskId: { type: "string", description: "The taskId returned from a background bash call." },
            block: { type: "boolean", description: "Whether to wait for the task to complete." },
            timeoutMs: { type: "integer", description: "Maximum time to wait in ms when block=true (max 30000)." },
        },
        required: ["taskId"],
        additionalProperties: false,
    },
};
const TASK_STOP_TOOL = {
    name: "task_stop",
    description: "Stop a running background task by killing its core process.",
    inputSchema: {
        type: "object",
        properties: { taskId: { type: "string", description: "The taskId returned from a background bash call." } },
        required: ["taskId"],
        additionalProperties: false,
    },
};
const TOOLS = [BASH_TOOL, ...FILE_TOOLS, READ_ARTIFACT_TOOL, LOAD_SKILL_TOOL, SPAWN_TASK_TOOL, TODO_WRITE_TOOL, REMEMBER_TOOL, WEB_FETCH_TOOL, TASK_OUTPUT_TOOL, TASK_STOP_TOOL];
const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;
/** 系统提示中单个记忆/约定小节的字符上限 */
const MEMORY_SECTION_LIMIT = 8_000;
export class SteeringError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "SteeringError";
    }
}
export class AgentRunner {
    sessions;
    providers;
    core;
    events;
    pricing;
    exchangeRates;
    defaultLanguage;
    maxTurns;
    getProfile;
    usageLog;
    skills;
    mcp;
    compactor;
    dataDir;
    agents;
    commands;
    search;
    fetchImpl;
    backgroundTasks;
    hooks;
    running = new Map();
    shells = new Map();
    steering = new Map();
    repeatedCalls = new Map();
    mcpWarningSignatures = new Map();
    todos = new Map();
    permissions;
    constructor(sessions, providers, core, events, pricing, exchangeRates, defaultLanguage = "zh-CN", maxTurns = 50, getProfile = getModelProfile, usageLog, skills, mcp, compactor, dataDir, agents, commands, search, fetchImpl, backgroundTasks, hooks) {
        this.sessions = sessions;
        this.providers = providers;
        this.core = core;
        this.events = events;
        this.pricing = pricing;
        this.exchangeRates = exchangeRates;
        this.defaultLanguage = defaultLanguage;
        this.maxTurns = maxTurns;
        this.getProfile = getProfile;
        this.usageLog = usageLog;
        this.skills = skills;
        this.mcp = mcp;
        this.compactor = compactor;
        this.dataDir = dataDir;
        this.agents = agents;
        this.commands = commands;
        this.search = search;
        this.fetchImpl = fetchImpl;
        this.backgroundTasks = backgroundTasks;
        this.hooks = hooks;
        this.permissions = new PermissionCoordinator(events);
        core.on("event", (event) => {
            const payload = event.payload;
            const execution = payload?.execId ? this.executions.get(payload.execId) : undefined;
            if (event.type === "exec.output" &&
                execution &&
                payload?.stream &&
                payload.data &&
                typeof payload.seq === "number") {
                execution.output.push({ stream: payload.stream, data: payload.data, seq: payload.seq });
            }
            this.events.publish({
                source: "core",
                type: event.type,
                ...(execution ? { sessionId: execution.sessionId } : {}),
                payload: event.payload,
            });
        });
    }
    setDefaultLanguage(language) {
        this.defaultLanguage = language;
    }
    async run(sessionId, text, options) {
        if (this.running.has(sessionId))
            throw new Error("Session agent is already running");
        if (this.shells.has(sessionId))
            throw new Error("A shell command is pending; respond to its permission request first");
        const controller = new AbortController();
        this.running.set(sessionId, controller);
        try {
            const configuredSession = await this.sessions.get(sessionId);
            if (!configuredSession)
                throw new Error("Session not found");
            // 输入框 /技能名 手动触发：展开为技能全文 + 用户补充（检查点标题仍用原文）
            const effectiveText = await this.expandSkillCommand(configuredSession.cwd, text);
            // UserPromptSubmit 钩子：仅通知不阻断（否决语义为 PreToolUse 专属）
            if (this.hooks)
                await this.hooks.run("UserPromptSubmit", { sessionId, cwd: configuredSession.cwd, prompt: effectiveText.slice(0, 2000) });
            await this.core.configureSession({ sessionId, cwd: configuredSession.cwd, sandbox: configuredSession.sandbox ?? { enabled: true, readRoots: [configuredSession.cwd], writeRoots: [configuredSession.cwd], denyPaths: [], network: "allow" } });
            const checkpointContext = new ContextManager(this.sessions.contextRoot(sessionId));
            const checkpoint = await (await getSnapshotBackend(this.sessions, configuredSession))
                .create(text.slice(0, 80) || "User message", configuredSession.messages.length, await checkpointContext.load());
            this.events.publish({ source: "session", type: "checkpoint.created", sessionId, payload: checkpoint });
            await this.sessions.appendMessage(sessionId, "user", [
                ...(options?.images ?? []).map((image) => ({ type: "image", mediaType: image.mediaType, data: image.data })),
                ...(options?.attachments ?? []).map((block) => ({ type: "text", text: block.text })),
                { type: "text", text: effectiveText },
            ]);
            this.state(sessionId, "thinking");
            // 85% 水位强制概览压缩（§7.3 处理链⑤）：每次运行只触发一次
            let forceCompacted = false;
            for (let turn = 0; turn < this.maxTurns; turn++) {
                controller.signal.throwIfAborted();
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const context = new ContextManager(this.sessions.contextRoot(sessionId));
                const budget = await context.budgetStatus();
                if (budget.paused) {
                    this.state(sessionId, "budget_paused");
                    this.events.publish({ source: "agent", type: "agent.budget_paused", sessionId, payload: budget });
                    return;
                }
                const view = await context.buildView(session.messages);
                const cacheBreakpoints = selectCacheBreakpoints(view.messages, view.ledger);
                await context.recordCacheBreakpoints(cacheBreakpoints);
                const profile = this.getProfile(session.model);
                const estimatedTokens = estimateMessageTokens(view.messages);
                const workingBudget = Math.max(1, profile.contextWindow - profile.maxOutput);
                const utilization = estimatedTokens / workingBudget;
                this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, maxOutput: profile.maxOutput, workingBudget, utilization, warning: utilization >= 0.85 ? "force_compact" : utilization >= 0.7 ? "compact_recommended" : undefined } });
                // 85% 水位强制概览压缩：压缩成功后重建视图（消耗一个 turn 防止死循环）
                if (utilization >= 0.85 && this.compactor && !forceCompacted) {
                    forceCompacted = true;
                    try {
                        const compacted = await this.compactor.compact(sessionId, "overview", { forced: true });
                        if (compacted.changed) {
                            this.events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: compacted.mode, uptoIndex: compacted.uptoIndex ?? 0, forced: true } });
                            continue;
                        }
                    }
                    catch (error) {
                        // 压缩失败不阻断运行：记录后按未压缩视图继续
                        this.events.publish({ source: "agent", type: "context.compact_failed", sessionId, payload: { message: error instanceof Error ? error.message : String(error) } });
                    }
                }
                const provider = this.providers.get(session.provider);
                if (!provider)
                    throw new Error(`Provider ${session.provider} is not configured`);
                // 技能目录注入系统提示：每轮现扫，保证新增技能即时可见
                const skillCatalog = this.skills ? await this.skills.listFor(session.cwd) : [];
                const skillSection = skillCatalog.length > 0
                    ? `\n\nAvailable skills (load full text with the load_skill tool when relevant; the user can also trigger one with /name):\n${skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
                    : "";
                const agentCatalog = this.agents ? await this.agents.listFor(session.cwd) : [];
                const agentSection = agentCatalog.length > 0
                    ? `\n\nAvailable sub-agents (pass agent=<name> to spawn_task; omit for the default read-only explorer):\n${agentCatalog.map((agent) => {
                        const ignored = (agent.tools ?? []).filter((tool) => !SUB_AGENT_TOOL_NAMES.includes(tool));
                        return `- ${agent.name}: ${agent.description}${ignored.length > 0 ? ` (unsupported tools ignored: ${ignored.join(", ")})` : ""}`;
                    }).join("\n")}`
                    : "";
                // MCP 工具：失败 server 降级为告警（同一组告警每轮只播一次）
                const mcpBinding = this.mcp ? await this.mcp.toolsFor(session.cwd) : { tools: [], warnings: [] };
                if (mcpBinding.warnings.length > 0) {
                    const signature = mcpBinding.warnings.join("\n");
                    if (this.mcpWarningSignatures.get(sessionId) !== signature) {
                        this.mcpWarningSignatures.set(sessionId, signature);
                        for (const message of mcpBinding.warnings) {
                            this.events.publish({ source: "agent", type: "mcp.degraded", sessionId, payload: { message } });
                        }
                    }
                }
                else {
                    this.mcpWarningSignatures.delete(sessionId);
                }
                // 长期记忆注入（§2.3/§7.5）：CLAUDE.md/AGENTS.md + 项目/全局 memory.md，每轮现读
                const memorySection = await this.buildMemorySection(session.cwd);
                // 后台任务完成提示（读后即清）
                const bgNotices = this.backgroundTasks?.drainNotices(sessionId) ?? [];
                const bgNoticeSection = bgNotices.length > 0 ? `\n\n${bgNotices.join("\n")}` : "";
                const turn = await collectProviderTurn(provider, {
                    model: session.model,
                    ...(session.thinking ? { thinking: session.thinking } : {}),
                    ...(session.effort ? { effort: session.effort } : {}),
                    system: `You are OpenWebCode. The workspace is ${session.cwd}. Respond in ${this.defaultLanguage} unless the user explicitly requests another language.${skillSection}${agentSection}${memorySection}${bgNoticeSection}${session.agentMode === "plan" ? "\n\nYou are in PLAN mode (read-only). Investigate with read-only tools, then output a step-by-step implementation plan and ask the user to switch to build mode to execute it." : ""}`,
                    messages: view.messages,
                    cacheBreakpoints,
                    tools: [...TOOLS, ...(this.search ? [WEB_SEARCH_TOOL] : []), ...mcpBinding.tools],
                    signal: controller.signal,
                }, {
                    onRetry: ({ attemptId, attempt, delayMs, error }) => {
                        this.events.publish({
                            source: "agent",
                            type: "provider.retry",
                            sessionId,
                            payload: { attemptId, attempt, delayMs, kind: error.kind, message: error.message },
                        });
                    },
                });
                this.events.publish({ source: "agent", type: "message.attempt", sessionId, payload: { attemptId: turn.attemptId } });
                const assistantContent = [];
                let activeThinkingIndex;
                let stopReason;
                for (const event of turn.events) {
                    if (event.type === "text_delta") {
                        // Provider 文本以 token/chunk 形式流入。相邻分片属于同一段正文，
                        // 落盘前合并，避免前端把每个分片当成独立块而逐词换行。
                        const previous = assistantContent.at(-1);
                        if (previous?.type === "text")
                            previous.text = `${previous.text ?? ""}${event.text}`;
                        else
                            assistantContent.push({ type: "text", text: event.text });
                        this.events.publish({ source: "agent", type: "message.delta", sessionId, payload: { text: event.text } });
                    }
                    else if (event.type === "thinking_delta") {
                        const activeThinking = activeThinkingIndex === undefined ? undefined : assistantContent[activeThinkingIndex];
                        if (activeThinking?.type === "thinking") {
                            activeThinking.text = `${activeThinking.text ?? ""}${event.text}`;
                        }
                        else {
                            assistantContent.push({ type: "thinking", text: event.text, provider: provider.name });
                            activeThinkingIndex = assistantContent.length - 1;
                        }
                        this.events.publish({ source: "agent", type: "message.thinking_delta", sessionId, payload: { text: event.text } });
                    }
                    else if (event.type === "thinking_end") {
                        const completedThinking = {
                            type: "thinking",
                            text: event.text,
                            ...(event.signature ? { signature: event.signature } : {}),
                            provider: provider.name,
                        };
                        if (activeThinkingIndex === undefined)
                            assistantContent.push(completedThinking);
                        else
                            assistantContent[activeThinkingIndex] = completedThinking;
                        activeThinkingIndex = undefined;
                    }
                    else if (event.type === "tool_call") {
                        assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
                    }
                    else if (event.type === "usage") {
                        await this.recordUsageEvent(sessionId, context, session.provider, session.model, event);
                    }
                    else {
                        stopReason = event.stopReason;
                    }
                }
                if (assistantContent.length > 0) {
                    await this.sessions.appendMessage(sessionId, "assistant", assistantContent);
                }
                if (stopReason !== "tool_use") {
                    if (this.steering.get(sessionId)?.length) {
                        await this.applySteering(sessionId);
                        this.state(sessionId, "thinking");
                        continue;
                    }
                    // Stop 钩子：run 正常结束时通知（abort/error 路径不触发）
                    if (this.hooks)
                        await this.hooks.run("Stop", { sessionId, cwd: session.cwd });
                    return;
                }
                const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
                if (toolCalls.length === 0)
                    throw new Error("Provider stopped for tool use without a tool call");
                for (const call of toolCalls) {
                    const repeated = this.recordToolCall(sessionId, call.name, call.input);
                    if (repeated >= 3) {
                        const content = `Tool call blocked: ${call.name} was requested with identical arguments ${repeated} consecutive times.`;
                        this.events.publish({ source: "agent", type: "tool.repeated", sessionId, payload: { name: call.name, input: call.input, count: repeated } });
                        await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId: call.id, content, isError: true }]);
                        continue;
                    }
                    const permission = await this.authorizeTool(sessionId, call.name, call.input, controller.signal);
                    if (!permission.allowed) {
                        await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId: call.id, content: permission.reason ?? "Tool permission denied", isError: true }]);
                        continue;
                    }
                    // PreToolUse 钩子：exit 2 否决 → 工具不执行，stderr 回填 LLM
                    if (this.hooks) {
                        const outcome = await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: call.name, input: call.input });
                        if (outcome.blocked) {
                            await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId: call.id, content: outcome.reason ?? "Blocked by hook", isError: true }]);
                            continue;
                        }
                    }
                    const result = await this.executeTool(sessionId, call.name, call.id, call.input, controller.signal);
                    await this.sessions.appendMessage(sessionId, "tool", [result]);
                    // PostToolUse 钩子：仅写类工具成功后触发（format-on-write 等），不阻断
                    if (this.hooks && !result.isError && ["write_file", "edit_file", "bash"].includes(call.name)) {
                        const summary = result.content.slice(0, 300);
                        await this.hooks.run("PostToolUse", { sessionId, cwd: session.cwd, tool: call.name, input: call.input, result: { summary } });
                    }
                }
                await context.advanceRound();
                const afterTools = await this.sessions.get(sessionId);
                if (afterTools) {
                    await context.evict(afterTools.messages);
                    this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: (await context.load()).entries });
                }
                if (this.steering.get(sessionId)?.length)
                    await this.applySteering(sessionId);
                this.state(sessionId, "thinking");
            }
            throw new Error(`Agent exceeded ${this.maxTurns} turns`);
        }
        catch (error) {
            if (controller.signal.aborted) {
                this.events.publish({
                    source: "agent",
                    type: "agent.aborted",
                    sessionId,
                    payload: { message: "Agent run aborted" },
                });
                this.state(sessionId, "aborted");
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
            throw error;
        }
        finally {
            this.running.delete(sessionId);
            this.repeatedCalls.delete(sessionId);
            // abort 路径保留未应用的 steering 队列，供用户编辑/重发；正常结束才清理
            if (!controller.signal.aborted)
                this.steering.delete(sessionId);
            this.todos.delete(sessionId);
            this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items: [] } });
            this.state(sessionId, "idle");
        }
    }
    listTodos(sessionId) {
        return [...(this.todos.get(sessionId) ?? [])];
    }
    listPendingPermissions(sessionId) {
        return this.permissions.listPending(sessionId);
    }
    async preparePermissionResponse(sessionId, requestId, decision, reason) {
        const response = this.permissions.respond(sessionId, requestId, decision, reason);
        if (!response)
            return undefined;
        try {
            if (response.persist) {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const rule = permissionRule(response.tool, response.input);
                const rules = [...(session.permissionRules ?? []).filter((item) => item.tool !== rule.tool || item.argumentPrefix !== rule.argumentPrefix), rule];
                await this.sessions.updatePermissions(sessionId, session.permissionMode ?? "ask", rules);
            }
            // 由 HTTP 层在批准响应完成后调用，避免工具执行抢在响应发送前开始。
            return () => response.complete();
        }
        catch (error) {
            response.complete(false, "Failed to persist permission rule");
            throw error;
        }
    }
    abort(sessionId) {
        const controller = this.running.get(sessionId);
        if (!controller)
            return false;
        controller.abort();
        this.permissions.cancelSession(sessionId);
        return true;
    }
    /**
     * shell 快捷前缀 `!cmd`：走与 bash 工具相同的 authorizeTool 权限链 + core.run + boundToolResult 截断，
     * 但**不进 agent run 循环**（isRunning 全程 false）。落盘用户消息（`!cmd`）+ tool_result 一对，
     * 不触发 provider turn。
     *
     * 权限挂起复用现有 permission.request 事件 + respond 驱动机制：用独立 AbortController（不入 running Map），
     * respondPermission 路由驱动 permissions.request() 解析继续。run() 与 runShell() 通过 shells Map 互斥
     * （run() 开头检查 shells.has -> throw；shell 路由检查 isRunning -> 409）。
     *
     * PreToolUse/PostToolUse 钩子与 bash 工具一致触发（exit 2 否决 -> 错误 tool_result）。
     * 权限规则用 tool="bash" 复用现有 bash allow_always 规则（用户对 bash 的持久放行自动适用于 ! shell）。
     */
    async runShell(sessionId, cmd) {
        if (this.running.has(sessionId))
            throw new Error("Session agent is running; wait for it to finish before running a shell command");
        if (this.shells.has(sessionId))
            throw new Error("A shell command is already pending in this session");
        const controller = new AbortController();
        this.shells.set(sessionId, controller);
        const toolCallId = `shell-${randomUUID().slice(0, 8)}`;
        try {
            const session = await this.sessions.get(sessionId);
            if (!session)
                throw new Error("Session not found");
            // 沙盒配置幂等（与 /files 路由同款）；不写 configuredSessions 缓存（app.ts 私有，重复配置无害）
            await this.core.configureSession({
                sessionId,
                cwd: session.cwd,
                sandbox: session.sandbox ?? { enabled: true, readRoots: [session.cwd], writeRoots: [session.cwd], denyPaths: [], network: "allow" },
            });
            // 落盘用户消息（保留 ! 前缀作为 shell 标记，便于前端「发给 agent」按钮识别配对）
            await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text: `!${cmd}` }]);
            // 权限链（与 bash 工具一致；plan 模式会被门禁拦截）
            const permission = await this.authorizeTool(sessionId, "bash", { cmd }, controller.signal);
            if (!permission.allowed) {
                await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: permission.reason ?? "Shell command permission denied", isError: true }]);
                return;
            }
            // PreToolUse 钩子：exit 2 否决 -> 错误 tool_result
            if (this.hooks) {
                const outcome = await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: "bash", input: { cmd } });
                if (outcome.blocked) {
                    await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: outcome.reason ?? "Blocked by hook", isError: true }]);
                    return;
                }
            }
            const result = await this.executeBash(sessionId, cmd, toolCallId, controller.signal);
            await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: result.content, isError: result.isError }]);
            // PostToolUse 钩子：成功后触发（与 bash 工具一致，不阻断）
            if (this.hooks && !result.isError) {
                const summary = result.content.slice(0, 300);
                await this.hooks.run("PostToolUse", { sessionId, cwd: session.cwd, tool: "bash", input: { cmd }, result: { summary } });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
            // 尽力落盘错误 tool_result 防止丢失（appendMessage 自身失败则忽略）
            try {
                await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: message, isError: true }]);
            }
            catch {
                // 二次落盘失败不再抛错
            }
        }
        finally {
            this.shells.delete(sessionId);
        }
    }
    isRunning(sessionId) {
        return this.running.has(sessionId);
    }
    /** shell 快捷前缀 `!cmd` 是否在挂起中（权限审批/执行中）；agent.isRunning 全程 false。 */
    isShellPending(sessionId) {
        return this.shells.has(sessionId);
    }
    enqueueSteering(sessionId, content) {
        if (!this.running.has(sessionId))
            throw new SteeringError("Session agent is not running", "not_running");
        if (content.length > MAX_STEERING_LENGTH)
            throw new SteeringError(`Steering message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
        const queue = this.steering.get(sessionId) ?? [];
        if (queue.length >= MAX_STEERING_ITEMS)
            throw new SteeringError("Steering queue is full", "full");
        const item = { id: randomUUID(), content, createdAt: new Date().toISOString() };
        queue.push(item);
        this.steering.set(sessionId, queue);
        this.events.publish({ source: "agent", type: "steering.queued", sessionId, payload: { ...item, position: queue.length } });
        return { id: item.id, position: queue.length };
    }
    listSteering(sessionId) {
        return [...(this.steering.get(sessionId) ?? [])];
    }
    removeSteering(sessionId, id) {
        const queue = this.steering.get(sessionId);
        if (!queue)
            return false;
        const index = queue.findIndex((item) => item.id === id);
        if (index < 0)
            return false;
        const [item] = queue.splice(index, 1);
        if (!queue.length)
            this.steering.delete(sessionId);
        this.events.publish({ source: "agent", type: "steering.removed", sessionId, payload: { id: item.id } });
        return true;
    }
    async applySteering(sessionId) {
        const queue = this.steering.get(sessionId);
        if (!queue?.length)
            return;
        const remaining = [];
        for (const item of queue) {
            try {
                await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text: item.content }]);
                this.events.publish({ source: "agent", type: "steering.applied", sessionId, payload: item });
            }
            catch {
                remaining.push(item);
            }
        }
        if (remaining.length)
            this.steering.set(sessionId, remaining);
        else
            this.steering.delete(sessionId);
    }
    async authorizeTool(sessionId, tool, input, signal) {
        const session = await this.sessions.get(sessionId);
        if (!session)
            return { allowed: false, reason: "Session not found" };
        // Plan 模式门禁：只读工具放行，其余一律拦截
        const PLAN_READONLY = new Set(["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "todo_write", "web_fetch", "web_search", "task_output"]);
        if (session.agentMode === "plan") {
            if (tool.startsWith("mcp__"))
                return { allowed: false, reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
            if (!PLAN_READONLY.has(tool))
                return { allowed: false, reason: `Plan 模式为只读：${tool} 被拦截。请输出实施计划并请用户切换到 build 模式执行。` };
        }
        const mode = session.permissionMode ?? "ask";
        const rules = session.permissionRules ?? [];
        if (!this.permissions.needsApproval(mode, rules, tool, input))
            return { allowed: true };
        this.state(sessionId, "waiting_permission");
        const result = await this.permissions.request(sessionId, tool, input, signal);
        this.state(sessionId, "tool_running");
        return { allowed: result.allowed, ...(result.reason ? { reason: result.reason } : {}) };
    }
    async expandSkillCommand(cwd, text) {
        const parsed = parseSkillCommand(text);
        if (!parsed)
            return text;
        const custom = this.commands ? await this.commands.find(cwd, parsed.name) : undefined;
        if (custom)
            return renderCommand(custom.body, parsed.rest);
        if (!this.skills)
            return text;
        const skill = await this.skills.find(cwd, parsed.name);
        if (!skill)
            return text;
        const request = parsed.rest !== "" ? parsed.rest : "Follow the skill instructions above.";
        return `[Skill "${skill.name}" — full text]\n${skill.body}\n\n[User request]\n${request}`;
    }
    /**
     * 长期记忆/项目约定注入（§2.3/§7.5）：host fs 直读 CLAUDE.md、AGENTS.md、
     * 项目 .owc/memory.md 与全局 <dataDir>/memory.md；每节独立标题、上限 8000 字符，
     * 读失败一律按不存在处理，绝不 throw 阻断 agent 循环。
     */
    async buildMemorySection(cwd) {
        const sections = [];
        const add = (title, body) => {
            const trimmed = body.trim();
            if (trimmed === "")
                return;
            const text = trimmed.length > MEMORY_SECTION_LIMIT ? `${trimmed.slice(0, MEMORY_SECTION_LIMIT)}…(truncated)` : trimmed;
            sections.push(`## ${title}\n${text}`);
        };
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            let body = "";
            try {
                body = await readFile(path.join(cwd, name), "utf8");
            }
            catch {
                // 不存在或不可读：跳过该节
            }
            add(name, body);
        }
        add("Project memory (.owc/memory.md)", await readProjectMemory(cwd));
        if (this.dataDir)
            add("Global memory", await readGlobalMemory(this.dataDir));
        return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
    }
    async executeTool(sessionId, name, toolCallId, input, signal) {
        if (name.startsWith("mcp__")) {
            if (!this.mcp) {
                return { type: "tool_result", toolCallId, content: "MCP is not enabled on this server", isError: true };
            }
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const result = await this.mcp.callTool(session.cwd, name, input);
                const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, result.content);
                this.events.publish({
                    source: "agent",
                    type: "tool.end",
                    sessionId,
                    payload: { toolCallId, result: { content: bounded.content }, truncated: bounded.truncated, isError: result.isError, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) },
                });
                return { type: "tool_result", toolCallId, content: bounded.content, isError: result.isError };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "web_fetch" || name === "web_search") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                signal.throwIfAborted();
                let value;
                if (name === "web_fetch") {
                    const url = typeof input.url === "string" ? input.url.trim() : "";
                    if (!url)
                        throw new Error("web_fetch requires a non-empty url");
                    value = await webFetch(url, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), signal });
                }
                else {
                    if (!this.search)
                        throw new Error("Web search is not configured");
                    const query = typeof input.query === "string" ? input.query.trim() : "";
                    if (!query)
                        throw new Error("web_search requires a non-empty query");
                    const requested = input.limit === undefined ? 5 : Number(input.limit);
                    if (!Number.isInteger(requested) || requested < 1)
                        throw new Error("web_search limit must be a positive integer");
                    value = await this.search.search(query, Math.min(requested, 10));
                }
                const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(value));
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: value, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
                return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "load_skill") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const skillName = String(input.name ?? "");
                const skill = this.skills ? await this.skills.find(session.cwd, skillName) : undefined;
                if (!skill)
                    throw new Error(`Unknown skill: ${skillName || "(empty)"}`);
                const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, skill.body);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { name: skill.name, source: skill.source }, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
                return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "spawn_task") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const provider = this.providers.get(session.provider);
                if (!provider)
                    throw new Error(`Provider ${session.provider} is not configured`);
                const prompt = String(input.prompt ?? "");
                if (!prompt)
                    throw new Error("spawn_task requires a non-empty prompt");
                const agentName = typeof input.agent === "string" ? input.agent.trim() : "";
                const definition = agentName && this.agents ? await this.agents.find(session.cwd, agentName) : undefined;
                if (agentName && !definition)
                    throw new Error(`Unknown sub-agent: ${agentName}`);
                const requestedTools = definition?.tools ?? (Array.isArray(input.tools) ? input.tools.map((item) => String(item)) : [...SUB_AGENT_TOOL_NAMES]);
                const toolNames = requestedTools.filter((tool) => SUB_AGENT_TOOL_NAMES.includes(tool));
                // 子代理期间不发布 message.delta/thinking_delta，避免污染主聊天流；
                // 子代理 token 经 onUsage 复用主循环记账路径，计入会话成本
                const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
                const result = await runSubAgent({
                    provider,
                    model: session.model,
                    ...(definition?.model ? { modelOverride: definition.model } : {}),
                    ...(definition ? { systemExtra: definition.body, agent: definition.name } : {}),
                    prompt,
                    toolNames,
                    core: this.core,
                    sessionId,
                    cwd: session.cwd,
                    contextRoot: this.sessions.contextRoot(sessionId),
                    signal,
                    onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, definition?.model ?? session.model, usage),
                });
                this.events.publish({
                    source: "agent",
                    type: "tool.end",
                    sessionId,
                    payload: { toolCallId, result: { conclusion: result.conclusion, turns: result.turns, toolsUsed: result.toolsUsed } },
                });
                return { type: "tool_result", toolCallId, content: result.conclusion, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "todo_write") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                if (!Array.isArray(input.items))
                    throw new Error("todo_write requires an items array");
                const items = input.items.map((raw) => {
                    if (!raw || typeof raw !== "object")
                        throw new Error("Each todo item must be an object");
                    const item = raw;
                    const content = typeof item.content === "string" ? item.content.trim() : "";
                    if (!content)
                        throw new Error("Each todo item requires non-empty content");
                    if (!["pending", "in_progress", "done"].includes(item.status))
                        throw new Error(`Invalid todo status: ${String(item.status)}`);
                    if (item.activeForm !== undefined && typeof item.activeForm !== "string")
                        throw new Error("Todo activeForm must be a string");
                    return { content, status: item.status, ...(item.activeForm ? { activeForm: item.activeForm } : {}) };
                });
                this.todos.set(sessionId, items);
                this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items } });
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { count: items.length } } });
                return { type: "tool_result", toolCallId, content: `Task list replaced (${items.length} item(s)).`, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "remember") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const fact = String(input.fact ?? "").trim();
                if (!fact)
                    throw new Error("remember requires a non-empty fact");
                // 写入路径固定两处，不接受任意路径；dataDir 未注入时全局记忆不可用
                const scope = input.scope === "global" ? "global" : "project";
                const target = scope === "global"
                    ? (this.dataDir ? path.join(this.dataDir, "memory.md") : undefined)
                    : path.join(session.cwd, ".owc", "memory.md");
                if (!target)
                    throw new Error("Global memory is not available: server data directory is not configured");
                const { appended } = await appendMemory(target, [fact]);
                const content = appended > 0
                    ? `Remembered in ${scope} memory (${target}): ${appended} fact(s) appended.`
                    : `Fact already present in ${scope} memory (${target}); nothing appended.`;
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { scope, path: target, appended } } });
                return { type: "tool_result", toolCallId, content, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "read_artifact") {
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const manager = new ContextManager(this.sessions.contextRoot(sessionId));
                const content = await manager.readArtifact(String(input.artifactId), Number(input.offset), Number(input.limit));
                return { type: "tool_result", toolCallId, content, isError: false };
            }
            catch (error) {
                return { type: "tool_result", toolCallId, content: error instanceof Error ? error.message : String(error), isError: true };
            }
        }
        if (FILE_TOOLS.some((tool) => tool.name === name)) {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const path = typeof input.path === "string" ? input.path : "";
                if (!path)
                    throw new Error(`${name} requires a non-empty path`);
                let value;
                if (name === "read_file")
                    value = await this.core.readFile({ sessionId, path, ...(input.offset === undefined ? {} : { offset: Number(input.offset) }), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) });
                else if (name === "write_file")
                    value = await this.core.writeFile({ sessionId, path, content: String(input.content ?? ""), ...(input.createDirs === undefined ? {} : { createDirs: Boolean(input.createDirs) }) });
                else if (name === "edit_file")
                    value = await this.core.editFile({ sessionId, path, oldText: String(input.oldText ?? ""), newText: String(input.newText ?? ""), ...(input.replaceAll === undefined ? {} : { replaceAll: Boolean(input.replaceAll) }) });
                else if (name === "glob")
                    value = await this.core.globFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
                else
                    value = await this.core.grepFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
                const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(value));
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: value, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
                return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "task_output") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const taskId = String(input.taskId ?? "");
                if (!taskId)
                    throw new Error("task_output requires a non-empty taskId");
                const block = Boolean(input.block);
                const timeoutMs = Math.min(Number(input.timeoutMs) || 30000, 30000);
                if (!this.backgroundTasks)
                    throw new Error("Background tasks are not enabled");
                if (block) {
                    const deadline = Date.now() + timeoutMs;
                    const poll = async () => {
                        const entry = this.backgroundTasks.get(taskId);
                        if (!entry)
                            throw new Error(`Task not found: ${taskId}`);
                        if (entry.status !== "running")
                            return entry;
                        if (Date.now() >= deadline)
                            return entry;
                        await new Promise((resolve) => setTimeout(resolve, 250));
                        return poll();
                    };
                    const result = await poll();
                    this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result } });
                    return { type: "tool_result", toolCallId, content: JSON.stringify(result), isError: false };
                }
                const entry = this.backgroundTasks.get(taskId);
                if (!entry)
                    throw new Error(`Task not found: ${taskId}`);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: entry } });
                return { type: "tool_result", toolCallId, content: JSON.stringify(entry), isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name === "task_stop") {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                const taskId = String(input.taskId ?? "");
                if (!taskId)
                    throw new Error("task_stop requires a non-empty taskId");
                if (!this.backgroundTasks)
                    throw new Error("Background tasks are not enabled");
                const stopped = await this.backgroundTasks.stop(taskId);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { stopped } } });
                return { type: "tool_result", toolCallId, content: JSON.stringify({ stopped }), isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        if (name !== "bash" || typeof input.cmd !== "string" || !input.cmd) {
            return { type: "tool_result", toolCallId, content: `Unsupported or invalid tool call: ${name}`, isError: true };
        }
        // 后台 bash：独立 core 进程，不阻塞主循环
        if (input.run_in_background) {
            this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
            this.state(sessionId, "tool_running");
            try {
                if (!this.backgroundTasks)
                    throw new Error("后台任务未启用");
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                if (session.sandboxMode === "wsb")
                    throw new Error("WSB 沙盒模式不支持后台 bash");
                if (session.workspace?.mode === "managed")
                    throw new Error("托管工作区不支持后台 bash");
                const taskId = `task-${randomUUID().slice(0, 8)}`;
                await this.backgroundTasks.start({
                    sessionId,
                    taskId,
                    cmd: input.cmd,
                    cwd: session.cwd,
                });
                const result = { taskId, status: "started" };
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result } });
                return { type: "tool_result", toolCallId, content: JSON.stringify(result), isError: false };
            }
            catch (error) {
                const content = error instanceof Error ? error.message : String(error);
                this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
                return { type: "tool_result", toolCallId, content, isError: true };
            }
        }
        const bashResult = await this.executeBash(sessionId, input.cmd, toolCallId, signal);
        return { type: "tool_result", toolCallId, content: bashResult.content, isError: bashResult.isError };
    }
    /**
     * 前台 bash 执行（runShell 与 executeTool 的 bash 分支共用）：
     * core.run + exec.output 推送收集 + boundToolResult 截断。
     * 失败转成 isError=true 返回，不抛错（调用方负责落盘 tool_result）。
     */
    async executeBash(sessionId, cmd, toolCallId, signal) {
        signal.throwIfAborted();
        const execId = `${sessionId}:${randomUUID()}`;
        const execution = { sessionId, output: [] };
        this.executions.set(execId, execution);
        this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name: "bash", input: { cmd }, execId } });
        this.state(sessionId, "tool_running");
        try {
            const session = await this.sessions.get(sessionId);
            if (!session)
                throw new Error("Session not found");
            const result = await this.core.run({ sessionId, execId, cmd, cwd: session.cwd });
            const output = execution.output
                .sort((a, b) => a.seq - b.seq)
                .map((chunk) => ({
                stream: chunk.stream,
                data: Buffer.from(chunk.data, "base64").toString("utf8"),
            }));
            const rawContent = JSON.stringify({ ...result, output });
            const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), "bash", rawContent);
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
            return { content: bounded.content, isError: false };
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            const content = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
            return { content, isError: true };
        }
        finally {
            this.executions.delete(execId);
        }
    }
    // 用量记账：主循环与 spawn_task 子代理共用同一 ledger/用量日志/事件路径
    async recordUsageEvent(sessionId, context, providerName, model, event) {
        const usageCost = calculateUsageCost(event, this.pricing.get(providerName, model), this.exchangeRates?.current());
        const recordedCost = {
            priced: usageCost.priced,
            ...(usageCost.source ? { source: { currency: usageCost.source.currency, microUnits: usageCost.source.microUnits.toString() } } : {}),
            ...(usageCost.usd ? { usdMicroUnits: usageCost.usd.microUnits.toString() } : {}),
            ...(usageCost.cny ? { cnyMicroUnits: usageCost.cny.microUnits.toString() } : {}),
            ...(usageCost.exchangeRate ? {
                exchangeRate: {
                    rate: usageCost.exchangeRate.rate.toString(),
                    source: usageCost.exchangeRate.source,
                    effectiveDate: usageCost.exchangeRate.effectiveDate,
                    fetchedAt: usageCost.exchangeRate.fetchedAt,
                },
            } : {}),
        };
        const ledger = await context.recordUsage(event, recordedCost);
        // 全局用量日志（成本报表数据源）：失败只记 stderr，不阻断会话
        void this.usageLog?.record({
            at: new Date().toISOString(),
            sessionId,
            provider: providerName,
            model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheRead: event.cacheRead,
            cacheWrite: event.cacheWrite,
            priced: usageCost.priced,
            ...(usageCost.usd ? { usdMicroUnits: usageCost.usd.microUnits.toString() } : {}),
            ...(usageCost.cny ? { cnyMicroUnits: usageCost.cny.microUnits.toString() } : {}),
        }).catch((error) => {
            process.stderr.write(`[usage-log] 写入失败：${error instanceof Error ? error.message : String(error)}\n`);
        });
        this.events.publish({
            source: "agent",
            type: "context.usage",
            sessionId,
            payload: {
                ...event,
                cost: {
                    priced: usageCost.priced,
                    ...(usageCost.source ? { source: { currency: usageCost.source.currency, amount: usageCost.source.amount } } : {}),
                    ...(usageCost.usd ? { usd: usageCost.usd.amount } : {}),
                    ...(usageCost.cny ? { cny: usageCost.cny.amount } : {}),
                },
                sessionCost: ledger.cost,
            },
        });
    }
    recordToolCall(sessionId, name, input) {
        const signature = `${name}:${stableStringify(input)}`;
        const previous = this.repeatedCalls.get(sessionId);
        const count = previous?.signature === signature ? previous.count + 1 : 1;
        this.repeatedCalls.set(sessionId, { signature, count });
        return count;
    }
    executions = new Map();
    state(sessionId, state) {
        this.events.publish({ source: "agent", type: "agent.state", sessionId, payload: { state } });
    }
}
function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
