import Anthropic from "@anthropic-ai/sdk";
import { normalizeProviderError } from "./provider-error.js";
export class AnthropicProvider {
    name;
    client;
    maxTokens;
    promptCaching;
    constructor(options = {}) {
        this.name = options.name ?? "anthropic";
        this.maxTokens = options.maxTokens ?? 64_000;
        this.promptCaching = options.promptCaching ?? true;
        this.client = new Anthropic({
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        });
    }
    async *streamChat(request) {
        let streamStarted = false;
        try {
            const stream = this.client.messages.stream({
                model: request.model,
                max_tokens: this.maxTokens,
                ...(anthropicThinking(request, this.maxTokens) ? { thinking: anthropicThinking(request, this.maxTokens) } : {}),
                ...(request.effort ? { output_config: { effort: request.effort } } : {}),
                system: request.system,
                messages: toAnthropicMessages(request.messages, new Set(request.cacheBreakpoints ?? [])),
                tools: request.tools.map(toAnthropicTool),
                ...(this.promptCaching ? { cache_control: { type: "ephemeral" } } : {}),
            }, { signal: request.signal });
            for await (const event of stream) {
                streamStarted = true;
                if (event.type !== "content_block_delta")
                    continue;
                if (event.delta.type === "text_delta") {
                    yield { type: "text_delta", text: event.delta.text };
                }
                else if (event.delta.type === "thinking_delta") {
                    yield { type: "thinking_delta", text: event.delta.thinking };
                }
            }
            const message = await stream.finalMessage();
            for (const block of message.content) {
                if (block.type === "thinking") {
                    yield {
                        type: "thinking_end",
                        text: block.thinking,
                        signature: block.signature,
                    };
                }
                else if (block.type === "tool_use") {
                    yield {
                        type: "tool_call",
                        id: block.id,
                        name: block.name,
                        input: asObject(block.input),
                    };
                }
            }
            yield {
                type: "usage",
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
                cacheRead: message.usage.cache_read_input_tokens ?? 0,
                cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
            };
            yield { type: "done", stopReason: mapStopReason(message.stop_reason) };
        }
        catch (error) {
            throw normalizeProviderError(error, streamStarted);
        }
    }
}
function anthropicThinking(request, maxTokens) {
    if (!request.thinking || request.thinking === "disabled")
        return undefined;
    if (request.thinking === "adaptive")
        return { type: "adaptive", display: "summarized" };
    if (maxTokens < 2)
        throw new Error("Enabled thinking requires maxTokens of at least 2");
    return { type: "enabled", budget_tokens: Math.min(16_000, maxTokens - 1) };
}
function toAnthropicMessages(messages, breakpoints) {
    return messages.map((message) => {
        let result;
        if (message.role === "tool") {
            result = {
                role: "user",
                content: message.content
                    .filter((block) => block.type === "tool_result")
                    .map((block) => ({
                    type: "tool_result",
                    tool_use_id: block.toolCallId,
                    content: block.content,
                    is_error: block.isError,
                })),
            };
        }
        else if (message.role === "user") {
            result = {
                role: "user",
                content: message.content
                    .filter((block) => block.type === "text" || block.type === "image")
                    .map((block) => block.type === "text"
                    ? { type: "text", text: block.text }
                    : {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: block.mediaType,
                            data: block.data,
                        },
                    }),
            };
        }
        else {
            const content = [];
            for (const block of message.content) {
                if (block.type === "text")
                    content.push({ type: "text", text: block.text });
                else if (block.type === "tool_call") {
                    content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
                }
                else if (block.type === "thinking" && block.provider === "anthropic" && block.signature) {
                    content.push({ type: "thinking", thinking: block.text, signature: block.signature });
                }
            }
            result = { role: "assistant", content };
        }
        if (breakpoints.has(message.id) && Array.isArray(result.content) && result.content.length > 0) {
            const last = result.content.length - 1;
            result.content[last] = { ...result.content[last], cache_control: { type: "ephemeral" } };
        }
        return result;
    });
}
function toAnthropicTool(tool) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    };
}
function asObject(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return {};
    return input;
}
function mapStopReason(reason) {
    if (reason === "tool_use" || reason === "max_tokens" || reason === "refusal")
        return reason;
    if (reason === "end_turn" || reason === "stop_sequence")
        return "end_turn";
    return "error";
}
