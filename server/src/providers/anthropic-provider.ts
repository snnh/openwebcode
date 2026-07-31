import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "../sessions/types.js";
import { getUserAgent } from "../http.js";
import { normalizeProviderError } from "./provider-error.js";
import type { Provider, ProviderEvent, ProviderTool, StreamChatRequest } from "./provider.js";

export interface AnthropicProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  promptCaching?: boolean;
  /** 自定义请求体：浅合并进 messages 请求体，核心字段（model/messages/system/tools 等）优先；
   * max_tokens 例外——extraBody 中的 max_tokens 可覆盖默认值（API 强制要求该字段，无法省略）。 */
  extraBody?: Record<string, unknown>;
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly extraBody: Record<string, unknown> | undefined;
  readonly promptCaching: boolean;

  constructor(options: AnthropicProviderOptions = {}) {
    this.name = options.name ?? "anthropic";
    this.maxTokens = options.maxTokens ?? 64_000;
    this.extraBody = options.extraBody;
    this.promptCaching = options.promptCaching ?? true;
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      defaultHeaders: { "User-Agent": getUserAgent() },
    });
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    let streamStarted = false;
    // Anthropic API 强制要求 max_tokens（无法像 OpenAI 端那样省略）；extraBody 可覆盖默认值
    const extraMaxTokens = this.extraBody?.["max_tokens"];
    const maxTokens = request.maxTokens ?? (typeof extraMaxTokens === "number" ? extraMaxTokens : this.maxTokens);
    // 服务级（provider 配置）与请求级开关共同决定；任一关闭则不打任何显式断点。
    const caching = this.promptCaching && request.promptCaching !== false;
    try {
      const stream = this.client.messages.stream(
        {
          ...this.extraBody,
          model: request.model,
          max_tokens: maxTokens,
          ...(anthropicThinking(request, maxTokens) ? { thinking: anthropicThinking(request, maxTokens)! } : {}),
          // ultra 超出 Anthropic 枚举（SDK 只声明到 max）：封顶 max 透传，其余原样
          ...(request.effort ? { output_config: { effort: request.effort === "ultra" ? "max" as const : request.effort } } : {}),
          system: toAnthropicSystem(request, caching),
          messages: toAnthropicMessages(request.messages, messageBreakpoints(request, caching)),
          ...(request.tools.length > 0 ? { tools: toAnthropicTools(request.tools, caching) } : {}),
          ...(caching ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
        { signal: request.signal },
      );

      for await (const event of stream) {
        streamStarted = true;
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
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

function anthropicThinking(request: StreamChatRequest, maxTokens: number): Anthropic.ThinkingConfigParam | undefined {
  if (!request.thinking || request.thinking === "disabled") return undefined;
  if (request.thinking === "adaptive") return { type: "adaptive", display: "summarized" };
  if (maxTokens < 2) throw new Error("Enabled thinking requires maxTokens of at least 2");
  return { type: "enabled", budget_tokens: Math.min(16_000, maxTokens - 1) };
}

/** Anthropic 每请求至多 4 个断点（tools/system/messages 合计）。 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * system 组装：稳定前缀单独成块并打 ephemeral 断点；动态尾部（逐 turn 变化的通知）
 * 追加为不带断点的后续块，避免其变化污染稳定前缀的缓存。关闭缓存时退化为纯字符串。
 */
function toAnthropicSystem(request: StreamChatRequest, caching: boolean): string | Anthropic.TextBlockParam[] {
  const suffix = request.systemSuffix?.trim();
  if (!caching) return suffix ? `${request.system}\n\n${suffix}` : request.system;
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
  ];
  if (suffix) blocks.push({ type: "text", text: suffix });
  return blocks;
}

/** 消息级断点预算：system 块占 1 个，tools 末位占 1 个，剩余额度给消息前缀（取最早者，缓存前缀最长）。 */
function messageBreakpoints(request: StreamChatRequest, caching: boolean): ReadonlySet<string> {
  if (!caching) return new Set();
  const budget = MAX_CACHE_BREAKPOINTS - 1 - (request.tools.length > 0 ? 1 : 0);
  return new Set((request.cacheBreakpoints ?? []).slice(0, Math.max(0, budget)));
}

/** 工具定义逐 turn 稳定，末位工具打断点即可缓存整个 tools 前缀。 */
function toAnthropicTools(tools: ProviderTool[], caching: boolean): Anthropic.Tool[] {
  return tools.map((tool, index) => ({
    ...toAnthropicTool(tool),
    ...(caching && index === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }) as Anthropic.Tool);
}

function toAnthropicMessages(messages: ChatMessage[], breakpoints: ReadonlySet<string>): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    let result: Anthropic.MessageParam;
    if (message.role === "tool") {
      result = {
        role: "user",
        content: message.content
          .filter((block) => block.type === "tool_result")
          .map((block) => ({
            type: "tool_result" as const,
            tool_use_id: block.toolCallId,
            content: block.content,
            is_error: block.isError,
          })),
      };
    } else if (message.role === "user") {
      result = {
        role: "user",
        content: message.content
          .filter((block) => block.type === "text" || block.type === "image")
          .map((block): Anthropic.ContentBlockParam => block.type === "text"
            ? { type: "text" as const, text: block.text }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: block.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  data: block.data,
                },
              }),
      };
    } else {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_call") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        } else if (block.type === "thinking" && block.provider === "anthropic" && block.signature) {
          content.push({ type: "thinking", thinking: block.text, signature: block.signature });
        }
      }
      result = { role: "assistant", content };
    }
    if (breakpoints.has(message.id) && Array.isArray(result.content) && result.content.length > 0) {
      const last = result.content.length - 1;
      result.content[last] = { ...result.content[last], cache_control: { type: "ephemeral" } } as typeof result.content[number];
    }
    return result;
  });
}

function toAnthropicTool(tool: ProviderTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
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
