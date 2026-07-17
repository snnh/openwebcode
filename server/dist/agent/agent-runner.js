import { randomUUID } from "node:crypto";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { estimateTokens, getModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule } from "./permission-coordinator.js";
import { GitShadowSnapshots } from "../snapshots/git-shadow.js";
const BASH_TOOL = {
    name: "bash",
    description: "Execute a shell command in the session workspace. Call this when command-line execution is required.",
    inputSchema: {
        type: "object",
        properties: { cmd: { type: "string" } },
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
const TOOLS = [BASH_TOOL, ...FILE_TOOLS, READ_ARTIFACT_TOOL];
const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;
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
    running = new Map();
    steering = new Map();
    repeatedCalls = new Map();
    permissions;
    constructor(sessions, providers, core, events, pricing, exchangeRates, defaultLanguage = "zh-CN", maxTurns = 50, getProfile = getModelProfile) {
        this.sessions = sessions;
        this.providers = providers;
        this.core = core;
        this.events = events;
        this.pricing = pricing;
        this.exchangeRates = exchangeRates;
        this.defaultLanguage = defaultLanguage;
        this.maxTurns = maxTurns;
        this.getProfile = getProfile;
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
    async run(sessionId, text) {
        if (this.running.has(sessionId))
            throw new Error("Session agent is already running");
        const controller = new AbortController();
        this.running.set(sessionId, controller);
        try {
            const configuredSession = await this.sessions.get(sessionId);
            if (!configuredSession)
                throw new Error("Session not found");
            await this.core.configureSession({ sessionId, cwd: configuredSession.cwd, sandbox: configuredSession.sandbox ?? { enabled: true, readRoots: [configuredSession.cwd], writeRoots: [configuredSession.cwd], denyPaths: [], network: "allow" } });
            const checkpointContext = new ContextManager(this.sessions.contextRoot(sessionId));
            const checkpoint = await new GitShadowSnapshots(this.sessions.contextRoot(sessionId), configuredSession.cwd)
                .create(text.slice(0, 80) || "User message", configuredSession.messages.length, await checkpointContext.load());
            this.events.publish({ source: "session", type: "checkpoint.created", sessionId, payload: checkpoint });
            await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text }]);
            this.state(sessionId, "thinking");
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
                const estimatedTokens = estimateTokens(JSON.stringify(view.messages));
                const workingBudget = Math.max(1, profile.contextWindow - profile.maxOutput);
                const utilization = estimatedTokens / workingBudget;
                this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, maxOutput: profile.maxOutput, workingBudget, utilization, warning: utilization >= 0.85 ? "force_compact" : utilization >= 0.7 ? "compact_recommended" : undefined } });
                const provider = this.providers.get(session.provider);
                if (!provider)
                    throw new Error(`Provider ${session.provider} is not configured`);
                const turn = await collectProviderTurn(provider, {
                    model: session.model,
                    ...(session.thinking ? { thinking: session.thinking } : {}),
                    ...(session.effort ? { effort: session.effort } : {}),
                    system: `You are OpenWebCode. The workspace is ${session.cwd}. Respond in ${this.defaultLanguage} unless the user explicitly requests another language.`,
                    messages: view.messages,
                    cacheBreakpoints,
                    tools: TOOLS,
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
                let stopReason;
                for (const event of turn.events) {
                    if (event.type === "text_delta") {
                        assistantContent.push({ type: "text", text: event.text });
                        this.events.publish({ source: "agent", type: "message.delta", sessionId, payload: { text: event.text } });
                    }
                    else if (event.type === "thinking_delta") {
                        this.events.publish({ source: "agent", type: "message.thinking_delta", sessionId, payload: { text: event.text } });
                    }
                    else if (event.type === "thinking_end") {
                        assistantContent.push({
                            type: "thinking",
                            text: event.text,
                            ...(event.signature ? { signature: event.signature } : {}),
                            provider: provider.name,
                        });
                    }
                    else if (event.type === "tool_call") {
                        assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
                    }
                    else if (event.type === "usage") {
                        const usageCost = calculateUsageCost(event, this.pricing.get(session.provider, session.model), this.exchangeRates?.current());
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
                    const result = await this.executeTool(sessionId, call.name, call.id, call.input, controller.signal);
                    await this.sessions.appendMessage(sessionId, "tool", [result]);
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
            this.state(sessionId, "idle");
        }
    }
    listPendingPermissions(sessionId) {
        return this.permissions.listPending(sessionId);
    }
    async respondPermission(sessionId, requestId, decision, reason) {
        const response = this.permissions.respond(sessionId, requestId, decision, reason);
        if (!response)
            return false;
        try {
            if (response.persist) {
                const session = await this.sessions.get(sessionId);
                if (!session)
                    throw new Error("Session not found");
                const rule = permissionRule(response.tool, response.input);
                const rules = [...(session.permissionRules ?? []).filter((item) => item.tool !== rule.tool || item.argumentPrefix !== rule.argumentPrefix), rule];
                await this.sessions.updatePermissions(sessionId, session.permissionMode ?? "ask", rules);
            }
            response.complete();
            return true;
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
    isRunning(sessionId) {
        return this.running.has(sessionId);
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
        const mode = session.permissionMode ?? "ask";
        const rules = session.permissionRules ?? [];
        if (!this.permissions.needsApproval(mode, rules, tool, input))
            return { allowed: true };
        this.state(sessionId, "waiting_permission");
        const result = await this.permissions.request(sessionId, tool, input, signal);
        this.state(sessionId, "tool_running");
        return { allowed: result.allowed, ...(result.reason ? { reason: result.reason } : {}) };
    }
    async executeTool(sessionId, name, toolCallId, input, signal) {
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
        if (name !== "bash" || typeof input.cmd !== "string" || !input.cmd) {
            return { type: "tool_result", toolCallId, content: `Unsupported or invalid tool call: ${name}`, isError: true };
        }
        signal.throwIfAborted();
        const execId = `${sessionId}:${randomUUID()}`;
        const execution = { sessionId, output: [] };
        this.executions.set(execId, execution);
        this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input, execId } });
        this.state(sessionId, "tool_running");
        try {
            const session = await this.sessions.get(sessionId);
            if (!session)
                throw new Error("Session not found");
            const result = await this.core.run({ sessionId, execId, cmd: input.cmd, cwd: session.cwd });
            const output = execution.output
                .sort((a, b) => a.seq - b.seq)
                .map((chunk) => ({
                stream: chunk.stream,
                data: Buffer.from(chunk.data, "base64").toString("utf8"),
            }));
            const rawContent = JSON.stringify({ ...result, output });
            const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, rawContent);
            const content = bounded.content;
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
            return { type: "tool_result", toolCallId, content, isError: false };
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            const content = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
            return { type: "tool_result", toolCallId, content, isError: true };
        }
        finally {
            this.executions.delete(execId);
        }
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
