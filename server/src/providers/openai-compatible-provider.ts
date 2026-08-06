import type { ChatMessage, ThinkingContent } from "../sessions/types.js";
import { getUserAgent } from "../http.js";
import { classifyHttpError, normalizeProviderError, parseRetryAfter, ProviderError, truncateErrorDetail } from "./provider-error.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

export interface OpenAICompatibleProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL: string;
  /** 显式设置才发送 max_tokens；缺省不限制输出长度（端点自行决定）。 */
  maxTokens?: number;
  /** 自定义请求体：浅合并进 chat/completions 请求体，核心字段（model/messages/stream/tools 等）优先。 */
  extraBody?: Record<string, unknown>;
  reasoningEffort?: boolean;
  /** 思维链保留回传：历史 assistant 消息中的同源 thinking 块以 reasoning_content 回带
   * （deepseek/qwen/glm/kimi 等新模型要求；端点不识别该字段时可显式 false 关闭）。 */
  reasoningContent?: boolean;
  /** SSE 流连续无 data 事件的最大毫秒数（心跳注释不计），超时判为半开连接断开并走重试；<=0 关闭。 */
  streamIdleTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/** SSE 流 idle 默认上限：5 分钟无 data 事件判半开。思考型模型在端点缓冲思考时可能长时间静默，
 * 该值需覆盖此类场景；代理/网关的心跳注释不会重置计时（见 readSseData）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** 单个 SSE 事件的字节上限：异常端点/代理可能持续喂字节却永不发送事件边界（空行），
 * 无界 buffer 会拖垮内存；超限属确定性协议错误，按不可重试处理（见 readSseData）。 */
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private readonly fetch: typeof fetch;
  private readonly maxTokens: number | undefined;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.name = options.name ?? "openai";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxTokens = options.maxTokens;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    let response: Response;
    const maxTokens = request.maxTokens ?? this.maxTokens;
    // 思维链回传：请求级（模型能力声明）优先，回落 provider 级配置（默认开）
    const reasoningContent = request.reasoningContent ?? (this.options.reasoningContent !== false);
    try {
      response = await this.fetch(`${this.options.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": getUserAgent(),
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...this.options.extraBody,
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        // 未显式配置则不发送 max_tokens：不限制输出长度
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(this.options.reasoningEffort !== false && request.effort ? { reasoning_effort: request.effort } : {}),
        messages: toOpenAIMessages(request.system, request.messages, this.name, reasoningContent),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      }),
        signal: request.signal,
      });
    } catch (error) {
      throw normalizeProviderError(error);
    }
    if (!response.ok || !response.body) {
      // 错误体可能很大且会随错误消息广播进 WS 事件流：截断后再进消息
      const detail = truncateErrorDetail(await response.text());
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
      for await (const data of readSseData(response.body, { idleTimeoutMs: this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS })) {
        streamStarted = true;
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as OpenAIChunk;
        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > chunk.usage.prompt_tokens) {
            throw new Error("OpenAI-compatible provider returned invalid cached token usage");
          }
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens - cachedTokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheRead: cachedTokens,
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
            // 参数流式分片：id 就绪后上报（首个分片通常即携带 id/name）
            if (current.id) {
              yield {
                type: "tool_call_delta",
                id: current.id,
                ...(current.name ? { name: current.name } : {}),
                argumentsDelta: call.function?.arguments ?? "",
              };
            }
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

export interface SseReadOptions {
  /** 连续无 data 事件的最大毫秒数（心跳注释不重置计时），超时判为半开连接；<=0 关闭。 */
  idleTimeoutMs?: number;
}

export async function* readSseData(body: ReadableStream<Uint8Array>, options?: SseReadOptions): AsyncIterable<string> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 计时只在产出 data 事件时重置：代理/网关的心跳注释（": ping"）会持续喂字节，
  // 按字节或按 chunk 计时都会被心跳无限续命，半开连接永远暴露不出来
  let idleDeadline = Date.now() + idleTimeoutMs;
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleTimeoutMs <= 0) return reader.read();
    const remaining = idleDeadline - Date.now();
    if (remaining <= 0) throw idleTimeoutError(idleTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(idleTimeoutError(idleTimeoutMs)), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    while (true) {
      const { done, value } = await read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const event = buffer.slice(0, match.index).replace(/\r/g, "");
        buffer = buffer.slice(match.index + match[0].length);
        const data = sseEventData(event);
        if (data) {
          idleDeadline = Date.now() + idleTimeoutMs;
          yield data;
        }
      }
      if (done) {
        // 流末尾残留 buffer 可能无空行终止（端点提前关连接）：按最后一个事件再解析一次，
        // 否则收尾事件（如 [DONE]）被静默丢弃，成功响应会因此判失败
        const data = sseEventData(buffer.replace(/\r/g, ""));
        if (data) yield data;
        break;
      }
      // 单事件字节上限：buffer 持续增长却等不到事件边界，判确定性协议错误（不可重试）
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES) {
        throw new ProviderError(
          "stream_interrupted",
          `SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes without an event boundary`,
          false,
        );
      }
    }
  } finally {
    // 超时/中断路径上读者可能还挂着 pending read：先 cancel 释放连接再 releaseLock
    try { await reader.cancel(); } catch { /* 流已关闭时忽略 */ }
    reader.releaseLock();
  }
}

/** 从一个 SSE 事件块（已去 \r）中提取 data 载荷：多行 data: 按 SSE 规范以 \n 拼接。 */
function sseEventData(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function idleTimeoutError(idleTimeoutMs: number): ProviderError {
  return new ProviderError(
    "stream_interrupted",
    `SSE stream produced no data events for ${Math.round(idleTimeoutMs / 1000)}s (treating the connection as half-open)`,
    true,
  );
}

function toOpenAIMessages(system: string, messages: ChatMessage[], providerName?: string, reasoningContent = true): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      const images = message.content.filter((block) => block.type === "image");
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      // 无图时维持纯字符串 content（兼容只认字符串的端点）；有图时走 parts 数组
      result.push({
        role: "user",
        content: images.length === 0
          ? text
          : [
              ...images.map((block) => ({ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } })),
              { type: "text", text },
            ],
      });
    } else if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((block) => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));
      // 思维链保留回传：只回带同源 provider 的 thinking 块（Anthropic 走自己的签名回放，
      // 异 provider 的 thinking 对当前端点无意义），含 tool_calls 的消息同样回带。
      const reasoning = reasoningContent && providerName
        ? message.content
            .filter((block): block is ThinkingContent => block.type === "thinking" && block.provider === providerName)
            .map((block) => block.text)
            .join("\n")
        : "";
      result.push({
        role: "assistant",
        content: message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("") || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
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
  // 参数 JSON 解析失败多为流被 max_tokens 截断：确定性错误，重试不会自愈，归不可重试
  // （否则 collectProviderTurn 会按 stream_interrupted 白重试）
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch (error) {
    throw new ProviderError(
      "invalid_request",
      `Tool call arguments are not valid JSON (the stream may have been truncated): ${error instanceof Error ? error.message : String(error)}`,
      false,
      undefined,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderError("invalid_request", "Tool arguments must be an object", false);
  }
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
