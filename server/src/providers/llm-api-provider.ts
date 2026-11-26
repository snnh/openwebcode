import { createLLM, isLLMError, type ChatRequest, type LLM, type LLMEvent, type LLMConfig } from "@snnh/llm-api";
import { getUserAgent } from "../user-agent.js";
import { buildAnthropicBody, type AnthropicProviderOptions } from "./anthropic-request.js";
import { buildGeminiBody, normalizeGeminiBaseURL } from "./gemini-request.js";
import { classifyHttpError, normalizeProviderError, ProviderError } from "./provider-error.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";
import { buildOpenAICompatibleBody, type OpenAICompatibleProviderOptions } from "./openai-compatible-provider.js";
import { buildOpenAIResponsesBody, type OpenAIResponsesProviderOptions } from "./openai-responses-provider.js";
import { encodeTextSignatureV1 } from "./responses-replay.js";

export interface LLMApiProviderOptions {
  name: string;
  interfaceType: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content";
  baseURL?: string;
  apiKey?: string;
  promptCaching?: boolean;
  includeUsage?: boolean;
  extraBody?: Record<string, unknown>;
  streamIdleTimeoutMs?: number;
  /** Test/embedding override; production uses global fetch. */
  fetch?: typeof fetch;
}

/**
 * @snnh/llm-api 传输适配层：协议请求体仍由各 provider 的纯函数构造，统一交给
 * llm-api 做认证、超时、重试关闭后的单次请求与 SSE 事件归一。
 *
 * 这样 OWC 的 Responses 原样回放、Anthropic 工具配对、prompt cache 断点等既有语义
 * 不因换调用层而改变；llm-api 负责统一的错误/事件边界，后续可以把请求体构造也
 * 逐步收敛进库。
 */
export class LLMApiProvider implements Provider {
  readonly name: string;
  readonly interfaceType: LLMApiProviderOptions["interfaceType"];
  readonly promptCaching: boolean;
  private readonly llm: LLM;
  private readonly bodyCache = new WeakMap<StreamChatRequest, Record<string, unknown>>();

  constructor(private readonly options: LLMApiProviderOptions) {
    this.name = options.name;
    this.interfaceType = options.interfaceType;
    this.promptCaching = options.promptCaching ?? true;
    this.llm = createLLM(this.config(), {
      env: process.env,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  private config(): LLMConfig {
    const anthropic = this.interfaceType === "anthropic-messages";
    const anthropicBase = (this.options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const anthropicPath = anthropicBase.endsWith("/v1") ? "/messages" : "/v1/messages";
    const baseURL = this.interfaceType === "gemini-generate-content"
      ? normalizeGeminiBaseURL(this.options.baseURL)
      : this.options.baseURL;
    return {
      version: 1,
      force: true,
      providers: [{
        id: this.name,
        interfaceType: this.interfaceType,
        // Anthropic SDK 的 baseURL 语义是「站点根」，messages 路径固定为 /v1/messages；
        // OWC 档案预设同样保存站点根（如 https://api.anthropic.com）。OpenAI 系的
        // baseURL 则已含 /v1，故只在 Anthropic 上补 path。
        ...(anthropic
          ? { baseUrl: anthropicBase, path: anthropicPath }
          : baseURL ? { baseUrl: baseURL } : {}),
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
        // 生产并发上限由 ProviderRegistry 的 ConcurrencyLimitedProvider 统一包装，
        // 这里不再叠加第二队列。重试同理收口在 collectProviderTurn。
        caching: anthropic ? (this.promptCaching ? "explicit" : "none") : "auto",
        includeUsage: this.options.includeUsage !== false,
        retry: { maxAttempts: 0 },
        family: "default",
        ...(this.options.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: this.options.streamIdleTimeoutMs }
          : {}),
      }],
      families: [{
        id: "default",
        provider: this.name,
        match: ["^"],
        force: true,
        contextWindow: 1_000_000,
        maxOutput: 64_000,
        capabilities: { tools: true, thinking: ["enabled", "disabled", "adaptive"] },
      }],
    };
  }

  private body(request: StreamChatRequest): Record<string, unknown> {
    const cached = this.bodyCache.get(request);
    if (cached) return cached;
    let body: Record<string, unknown>;
    if (this.interfaceType === "anthropic-messages") {
      const options: AnthropicProviderOptions = {
        ...(this.options.extraBody ? { extraBody: this.options.extraBody } : {}),
        promptCaching: this.promptCaching,
      };
      body = buildAnthropicBody(request, options);
    } else if (this.interfaceType === "gemini-generate-content") {
      body = buildGeminiBody(request, {
        providerName: this.name,
        ...(this.options.extraBody ? { extraBody: this.options.extraBody } : {}),
      });
    } else if (this.interfaceType === "openai-responses") {
      const options: OpenAIResponsesProviderOptions = {
        name: this.name,
        baseURL: this.options.baseURL ?? "https://api.openai.com/v1",
        ...(this.options.extraBody ? { extraBody: this.options.extraBody } : {}),
      };
      body = buildOpenAIResponsesBody(request, options);
    } else {
      const options: OpenAICompatibleProviderOptions = {
        name: this.name,
        baseURL: this.options.baseURL ?? "https://api.openai.com/v1",
        ...(this.options.extraBody ? { extraBody: this.options.extraBody } : {}),
        ...(this.options.includeUsage !== undefined ? { includeUsage: this.options.includeUsage } : {}),
      };
      body = buildOpenAICompatibleBody(request, options);
    }
    this.bodyCache.set(request, body);
    return body;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    const body = this.body(request);
    const chat: ChatRequest = {
      model: request.model,
      provider: this.name,
      messages: [],
      tools: [],
      rawBody: body,
      headers: { "user-agent": getUserAgent() },
      signal: request.signal,
    };
    let streamStarted = false;
    try {
      for await (const event of this.llm.chatStream(chat)) {
        const mapped = this.mapEvent(event);
        if (mapped) {
          streamStarted = true;
          yield mapped;
        }
      }
    } catch (error) {
      throw this.mapError(error, streamStarted);
    }
  }

  private mapEvent(event: LLMEvent): ProviderEvent | undefined {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta":
      case "tool_call_delta":
      case "tool_call":
      case "server_tool":
      case "web_search_call":
      case "done":
        return event;
      case "text_end":
        // Gemini 的 text_end.signature 是原生 thoughtSignature；Responses 则是 v1 item 签名。
        if (this.interfaceType === "gemini-generate-content") {
          return { type: "text_end", text: event.text, ...(event.signature ? { signature: event.signature } : {}) };
        }
        if (this.interfaceType !== "openai-responses") return undefined;
        return {
          type: "text_end",
          text: event.text,
          ...(event.signature
            ? { signature: event.signature }
            : event.itemId
              ? { signature: encodeTextSignatureV1(event.itemId, event.phase) }
              : {}),
        };
      case "thinking_end": {
        const signature = this.interfaceType === "openai-responses" && event.item
          ? JSON.stringify(event.item)
          : event.signature;
        return {
          type: "thinking_end",
          text: event.text,
          ...(signature ? { signature } : {}),
          ...(event.redacted ? { redacted: event.redacted } : {}),
        };
      }
      case "usage": {
        // OpenAI 系（chat / Responses）的 input_tokens 含 cache 读写；OWC 计费/水位
        // 口径要求拆开。Anthropic 的 input_tokens 本身不含 cache 读写，保持原值。
        const inputTokens = this.interfaceType === "anthropic-messages"
          ? event.inputTokens
          : Math.max(0, event.inputTokens - event.cacheRead - event.cacheWrite);
        return { type: "usage", inputTokens, outputTokens: event.outputTokens, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite };
      }
      case "error":
        throw event.error;
      default:
        return undefined;
    }
  }

  private mapError(error: unknown, streamStarted: boolean): unknown {
    if (error instanceof Error && error.name === "AbortError") return error;
    if (isLLMError(error)) {
      if (error.code === "ABORTED") return new DOMException(error.message, "AbortError");
      if (error.status !== undefined) {
        return classifyHttpError(error.status, error.message, error.retryAfterMs);
      }
      switch (error.code) {
        case "QUOTA":
          return new ProviderError("rate_limit", error.message, true, error.retryAfterMs);
        case "MISSING_CREDENTIAL":
          return new ProviderError("authentication", error.message, false);
        case "CONTEXT_WINDOW_EXCEEDED":
        case "INVALID_REQUEST":
        case "INVALID_CONFIG":
        case "UNSUPPORTED_FEATURE":
        case "UNKNOWN_MODEL":
          return new ProviderError("invalid_request", error.message, false);
        case "TRANSPORT":
          return streamStarted
            ? new ProviderError("stream_interrupted", error.message, true, error.retryAfterMs)
            : new ProviderError("network", error.message, true, error.retryAfterMs);
        default:
          return new ProviderError("unknown", error.message, false, undefined, { cause: error });
      }
    }
    return normalizeProviderError(error);
  }
}
