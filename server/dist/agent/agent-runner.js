import { randomUUID } from "node:crypto";
import { ContextManager } from "../context/context-manager.js";
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
export class AgentRunner {
    sessions;
    providers;
    core;
    events;
    maxTurns;
    running = new Map();
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
                const view = await context.buildView(session.messages);
                const provider = this.providers.get(session.provider);
                if (!provider)
                    throw new Error(`Provider ${session.provider} is not configured`);
                const assistantContent = [];
                let stopReason;
                for await (const event of provider.streamChat({
                    model: session.model,
                    system: `You are OpenWebCode. The workspace is ${session.cwd}.`,
                    messages: view.messages,
                    tools: [BASH_TOOL],
                    signal: controller.signal,
                })) {
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
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
            throw error;
        }
        finally {
            this.running.delete(sessionId);
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
            const content = JSON.stringify({ ...result, output });
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result } });
            return { type: "tool_result", toolCallId, content, isError: false };
        }
        catch (error) {
            const content = error instanceof Error ? error.message : String(error);
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
            return { type: "tool_result", toolCallId, content, isError: true };
        }
        finally {
            this.executions.delete(execId);
        }
    }
    executions = new Map();
    state(sessionId, state) {
        this.events.publish({ source: "agent", type: "agent.state", sessionId, payload: { state } });
    }
}
