export class DevelopmentProvider {
    name = "development";
    async *streamChat(request) {
        request.signal.throwIfAborted();
        const last = request.messages.at(-1);
        const toolResult = last?.content.find((block) => block.type === "tool_result");
        if (toolResult?.type === "tool_result") {
            const prefix = toolResult.isError ? "Tool failed: " : "Command completed: ";
            yield { type: "text_delta", text: prefix };
            yield { type: "text_delta", text: toolResult.content };
            yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
            yield { type: "done", stopReason: "end_turn" };
            return;
        }
        const text = last?.content.find((block) => block.type === "text");
        const artifact = text?.type === "text" ? parseArtifact(text.text) : undefined;
        if (artifact) {
            yield { type: "tool_call", id: `dev-artifact-${request.messages.length}`, name: "read_artifact", input: artifact };
            yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
            yield { type: "done", stopReason: "tool_use" };
            return;
        }
        const command = text?.type === "text" ? parseCommand(text.text) : undefined;
        if (!command) {
            yield { type: "text_delta", text: "Development provider is ready. Prefix a message with `run: ` to execute a command." };
            yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
            yield { type: "done", stopReason: "end_turn" };
            return;
        }
        yield {
            type: "tool_call",
            id: `dev-tool-${request.messages.length}`,
            name: "bash",
            input: { cmd: command },
        };
        yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "tool_use" };
    }
}
function parseArtifact(text) {
    const match = /^read-artifact:\s*(artifact-[0-9a-f-]{36})\s+(\d+)\s+(\d+)$/i.exec(text.trim());
    if (!match)
        return undefined;
    return { artifactId: match[1], offset: Number(match[2]), limit: Number(match[3]) };
}
function parseCommand(text) {
    const match = /^run:\s+(.+)$/s.exec(text.trim());
    return match?.[1];
}
