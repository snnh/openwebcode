import Anthropic from "@anthropic-ai/sdk";
import { getUserAgent } from "../user-agent.js";
import { normalizeProviderError } from "./provider-error.js";
import { buildAnthropicBody, type AnthropicProviderOptions } from "./anthropic-request.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";


const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 300_000;

/** 旧直连实现：仅保留协议请求体构造/回归测试；生产注册走 llm-api-provider.ts。 */
export class AnthropicProvider implements Provider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly extraBody: Record<string, unknown> | undefined;
  readonly promptCaching: boolean;
  readonly interfaceType = "anthropic-messages" as const;

  constructor(options: AnthropicProviderOptions = {}) {
    this.name = options.name ?? "anthropic";
    this.maxTokens = options.maxTokens ?? 64_000;
    this.extraBody = options.extraBody;
    this.promptCaching = options.promptCaching ?? true;
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      // SDK 内建重试（默认 2 次）关闭：重试统一收口 collectProviderTurn/retry.ts，
      // 避免与外层重试嵌套放大（2×3 次）
      maxRetries: 0,
      timeout: options.streamIdleTimeoutMs === 0 ? 0 : (options.streamIdleTimeoutMs ?? DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS),
      // UA 不在此固化：出站 UA 由 user-agent 模块动态解析（agent-presets 模拟开关可能
      // 在 provider 存活期间变更），故在每次 streamChat 的请求级 headers 中注入。
    });
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    let streamStarted = false;
    try {
      const stream = this.client.messages.stream(
        buildAnthropicBody(request, {
          maxTokens: this.maxTokens,
          promptCaching: this.promptCaching,
          ...(this.extraBody ? { extraBody: this.extraBody } : {}),
        }) as unknown as Anthropic.MessageCreateParamsStreaming,
        // 请求级 UA：每次请求取当前生效值（默认官方 UA，agent-presets 模拟开启时为拟态值）
        { signal: request.signal, headers: { "User-Agent": getUserAgent() } },
      );

      const toolBlockIds = new Map<number, string>();
      for await (const event of stream) {
        streamStarted = true;
        // 工具调用参数流式分片：content_block_start 给 id/name，input_json_delta 逐片给 partial_json
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolBlockIds.set(event.index, event.content_block.id);
          yield { type: "tool_call_delta", id: event.content_block.id, name: event.content_block.name, argumentsDelta: "" };
          continue;
        }
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "input_json_delta") {
          const id = toolBlockIds.get(event.index);
          if (id) yield { type: "tool_call_delta", id, argumentsDelta: event.delta.partial_json };
        } else if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
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
        } else if (block.type === "redacted_thinking") {
          // redacted_thinking 原样持久化（text 为空、载荷在 redacted）：下轮回传缺块会 400
          yield {
            type: "thinking_end",
            text: "",
            redacted: block.data,
          };
        } else if (block.type === "tool_use") {
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
    } catch (error) {
      throw normalizeProviderError(error, streamStarted);
    }
  }
}


function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error" {
  if (reason === "tool_use" || reason === "max_tokens" || reason === "refusal") return reason;
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn";
  return "error";
}
