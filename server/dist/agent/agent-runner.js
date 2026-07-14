import { randomUUID } from "node:crypto";
import { ContextManager } from "../context/context-manager.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { estimateTokens, getModelProfile } from "../context/model-profile.js";
import { collectProviderTurn } from "../providers/retry.js";
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
const TOOLS = [BASH_TOOL, READ_ARTIFACT_TOOL];
export class AgentRunner {
    sessions;
    providers;
    core;
    events;
    maxTurns;
    running = new Map();
    repeatedCalls = new Map();
    constructor(sessions, providers, core, events, maxTurns = 50) {
        this.sessions = sessions;
        this.providers = providers;
        this.core = core;
        this.events = events;
        this.maxTurns = maxTurns;
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
    async run(sessionId, text) {
        if (this.running.has(sessionId))
            throw new Error("Session agent is already running");
        const controller = new AbortController();
        this.running.set(sessionId, controller);
        try {
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
                const profile = getModelProfile(session.model);
                const estimatedTokens = estimateTokens(JSON.stringify(view.messages));
                const workingBudget = Math.max(1, profile.contextWindow - profile.maxOutput);
                const utilization = estimatedTokens / workingBudget;
                this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, maxOutput: profile.maxOutput, workingBudget, utilization, warning: utilization >= 0.85 ? "force_compact" : utilization >= 0.7 ? "compact_recommended" : undefined } });
                const provider = this.providers.get(session.provider);
                if (!provider)
                    throw new Error(`Provider ${session.provider} is not configured`);
                const turn = await collectProviderTurn(provider, {
                    model: session.model,
                    system: `You are OpenWebCode. The workspace is ${session.cwd}.`,
                    messages: view.messages,
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
                        await context.recordUsage(event);
                        this.events.publish({ source: "agent", type: "context.usage", sessionId, payload: event });
                    }
                    else {
                        stopReason = event.stopReason;
                    }
                }
                if (assistantContent.length > 0) {
                    await this.sessions.appendMessage(sessionId, "assistant", assistantContent);
                }
                if (stopReason !== "tool_use")
                    return;
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
                    const result = await this.executeTool(sessionId, call.name, call.id, call.input, controller.signal);
                    await this.sessions.appendMessage(sessionId, "tool", [result]);
                }
                await context.advanceRound();
                const afterTools = await this.sessions.get(sessionId);
                if (afterTools) {
                    await context.evict(afterTools.messages);
                    this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: (await context.load()).entries });
                }
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
            this.state(sessionId, "idle");
        }
    }
    abort(sessionId) {
        const controller = this.running.get(sessionId);
        if (!controller)
            return false;
        controller.abort();
        return true;
    }
    isRunning(sessionId) {
        return this.running.has(sessionId);
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
