import type { ChatMessage } from "../sessions/types.js";
import { classifyHttpError, normalizeProviderError, parseRetryAfter } from "./provider-error.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

export interface OpenAICompatibleProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private readonly fetch: typeof fetch;
  private readonly maxTokens: number;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.name = options.name ?? "openai";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxTokens = options.maxTokens ?? 64_000;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: this.maxTokens,
        messages: toOpenAIMessages(request.system, request.messages),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
        signal: request.signal,
      });
    } catch (error) {
      throw normalizeProviderError(error);
    }
    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw classifyHttpError(
        response.status,
        `OpenAI-compatible provider returned ${response.status}: ${detail}`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    const tools = new Map<number, ToolAccumulator>();
    let stopReason: string | null = null;
    let streamStarted = false;
    try {
      for await (const data of readSseData(response.body)) {
        streamStarted = true;
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as OpenAIChunk;
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWrite: 0,
          };
        }
        for (const choice of chunk.choices ?? []) {
          stopReason = choice.finish_reason ?? stopReason;
          if (choice.delta.content) yield { type: "text_delta", text: choice.delta.content };
          if (choice.delta.reasoning_content) {
            yield { type: "thinking_delta", text: choice.delta.reasoning_content };
          }
          for (const call of choice.delta.tool_calls ?? []) {
            const current = tools.get(call.index) ?? { id: "", name: "", arguments: "" };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.name += call.function.name;
            if (call.function?.arguments) current.arguments += call.function.arguments;
            tools.set(call.index, current);
          }
        }
      }
    } catch (error) {
      throw normalizeProviderError(error, streamStarted);
    }

    for (const call of [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
      yield {
        type: "tool_call",
        id: call.id,
        name: call.name,
        input: parseArguments(call.arguments),
      };
    }
    yield { type: "done", stopReason: mapStopReason(stopReason) };
  }
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const event = buffer.slice(0, match.index).replace(/\r/g, "");
        buffer = buffer.slice(match.index + match[0].length);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function toOpenAIMessages(system: string, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      result.push({
        role: "user",
        content: message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      });
    } else if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((block) => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));
      result.push({
        role: "assistant",
        content: message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("") || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          result.push({ role: "tool", tool_call_id: block.toolCallId, content: block.content });
        }
      }
    }
  }
  return result;
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function mapStopReason(reason: string | null): "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error" {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (reason === "stop") return "end_turn";
  return "error";
}

interface OpenAIChunk {
  choices?: Array<{
    finish_reason: string | null;
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}
