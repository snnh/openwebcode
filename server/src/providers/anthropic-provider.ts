import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ToolResultContent } from "../sessions/types.js";
import { getUserAgent } from "../user-agent.js";
import { normalizeProviderError } from "./provider-error.js";
import { anthropicToolResultContent, collectToolMedia } from "./tool-result-media.js";
import type { Provider, ProviderEvent, ProviderTool, StreamChatRequest } from "./provider.js";

interface AnthropicProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  promptCaching?: boolean;
  /** 自定义请求体：浅合并进 messages 请求体，核心字段（model/messages/system/tools 等）优先；
   * max_tokens 例外——extraBody 中的 max_tokens 可覆盖默认值（API 强制要求该字段，无法省略）。 */
  extraBody?: Record<string, unknown>;
  /** Maximum request duration in milliseconds; zero disables the SDK timeout. */
  streamIdleTimeoutMs?: number;
}

const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 300_000;

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
      // UA 不在此固化：出站 UA 由 user-agent 模块动态解析（env-sim 模拟开关可能
      // 在 provider 存活期间变更），故在每次 streamChat 的请求级 headers 中注入。
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
          // 思考强度（output_config.effort）值不设限：原样透传，不做任何封顶/映射
          // （ultra/minimal 等端点枚举外值由调用端点决定；官方枚举 low/medium/high/xhigh/max；
          // SDK 类型仅声明到自身枚举，运行时原样发送）
          ...(request.effort
            ? { output_config: { effort: request.effort } as unknown as Anthropic.Messages.OutputConfig }
            : {}),
          // 请求级采样参数（chat 模式助手预设下发）；undefined 时不发，由端点默认决定
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.topP !== undefined ? { top_p: request.topP } : {}),
          system: toAnthropicSystem(request, caching),
          messages: toAnthropicMessages(request.messages, messageBreakpoints(request, caching)),
          ...(request.tools.length > 0 ? { tools: toAnthropicTools(request.tools, caching) } : {}),
          ...(caching ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
        // 请求级 UA：每次请求取当前生效值（默认官方 UA，env-sim 模拟开启时为拟态值）
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

/**
 * Anthropic thinking 组装（Key 按声明 + 模型名推断，值不设限）：
 * - thinkingStyle="extended"：thinking:{type:"enabled",budget_tokens}（仅 Claude 4.5 及以前
 *   等旧模型的 extended-only 形态；预算不硬编码，由 maxTokens 推导——见 extendedThinkingBudget）
 * - thinkingStyle="adaptive"：thinking:{type:"adaptive"}（预算废弃时代，深度由 output_config.effort 控制）
 * - 未声明（或 openai 型声明，如 thinking）：按模型名推断——
 *   claude 4.5 及以前 → extended；claude 4.6+/国产/未知 → adaptive
 * - thinking=disabled → 不发（Anthropic 无 disable 表达，不传即关闭思考）
 * - 用户显式 enabled / adaptive → 按选定形态发送；未选择 → 不发（模型自动）
 */
function anthropicThinking(request: StreamChatRequest, maxTokens: number): Anthropic.ThinkingConfigParam | undefined {
  if (request.thinking === "disabled") return undefined;
  const style = request.thinkingStyle;
  if (style === "extended") {
    if (request.thinking !== "enabled") return undefined;
    return { type: "enabled", budget_tokens: extendedThinkingBudget(maxTokens) };
  }
  if (style === "adaptive") {
    return { type: "adaptive", display: "summarized" };
  }
  if (request.thinking === "adaptive") return { type: "adaptive", display: "summarized" };
  if (request.thinking !== "enabled") return undefined;
  return inferAnthropicThinking(request.model, maxTokens);
}

/** 版本号解析：兼容两代命名——新代 family 在前（claude-sonnet-4-5-20250929），
 * 旧代版本在前（claude-3-7-sonnet-20250219、claude-3-opus-20240229）。次版本限 1-2 位且
 * 后面不能再跟数字，避免把 8 位日期后缀（claude-sonnet-4-20250514）误读成次版本；
 * 缺次版本按 0 处理。 */
function parseClaudeVersion(model: string): { major: number; minor: number } | undefined {
  const family = "(?:opus|sonnet|haiku|fable|mythos)";
  const version = "(\\d{1,2})(?:[-_.](\\d{1,2})(?!\\d))?";
  const patterns = [
    new RegExp(`claude[-_./]?${family}[-_.]?${version}`, "i"),
    new RegExp(`claude[-_./]${version}[-_.]?${family}`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(model);
    if (match) return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
  }
  return undefined;
}

/** 模型名推断（Anthropic 官方文档）：Claude 4.5 及以前仅支持 extended（type:"adaptive" 会 400）；
 * 4.6+（及国产/未知端点）用 adaptive——预算（budget_tokens）已在该代弃用/拒绝。 */
function inferAnthropicThinking(model: string, maxTokens: number): Anthropic.ThinkingConfigParam {
  const version = parseClaudeVersion(model);
  if (version && (version.major <= 3 || (version.major === 4 && version.minor <= 5))) {
    return { type: "enabled", budget_tokens: extendedThinkingBudget(maxTokens) };
  }
  return { type: "adaptive", display: "summarized" };
}

/** Anthropic extended thinking 的硬约束：budget_tokens ≥ 1024 且 < max_tokens。 */
const MIN_THINKING_BUDGET = 1024;

/** extended 预算：预算与正文共享 max_tokens，取满 maxTokens-1 会让思考吃掉全部额度、
 * 正文无处可写（表现为"只有思考没有回答"），故留 1/8（至少 1024）给正文；
 * maxTokens 过小时退到 1024 下限，仍装不下则按 maxTokens-1 发出（由 API 明确拒绝而非静默截断）。 */
function extendedThinkingBudget(maxTokens: number): number {
  const headroom = Math.max(MIN_THINKING_BUDGET, Math.floor(maxTokens / 8));
  const budget = maxTokens - headroom;
  if (budget >= MIN_THINKING_BUDGET) return budget;
  return Math.min(MIN_THINKING_BUDGET, Math.max(1, maxTokens - 1));
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
  // 配对修复（与 openai-responses-provider 同款）：tool_use 与 tool_result 必须一一对应，
  // 否则端点 400（"unexpected tool_use_id" / "tool_use ids were found without tool_result"）。
  // 孤儿来源：!shell 直写 shell-* tool_result（无 assistant tool_use）、中断/崩溃时结果未落盘、
  // 压缩边界裁掉 assistant 留结果。游离 tool_result 丢弃；缺失结果在随后 user 消息补占位。
  const toolMedia = collectToolMedia(messages);
  const outputs = new Map<string, { content: string; isError?: boolean }>();
  const knownCallIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && !outputs.has(block.toolCallId)) {
        outputs.set(block.toolCallId, { content: block.content, ...(block.isError ? { isError: true } : {}) });
      } else if (block.type === "tool_call") {
        knownCallIds.add(block.id);
      }
    }
  }
  const placeholderResults = (ids: readonly string[]): Anthropic.ContentBlockParam[] =>
    ids.map((id) => {
      const output = outputs.get(id);
      return {
        type: "tool_result" as const,
        tool_use_id: id,
        // 附带媒体（read_media）内联进 tool_result：image 走 base64 source，视频降级占位文本
        content: anthropicToolResultContent(output?.content ?? "The run was interrupted before this tool finished; no result was produced.", output ? toolMedia.get(id) : undefined) as NonNullable<Anthropic.ToolResultBlockParam["content"]>,
        ...(output?.isError ? { is_error: true } : {}),
      };
    });
  const result: Anthropic.MessageParam[] = [];
  const emittedCallIds = new Set<string>();
  let pendingCallIds: string[] = [];
  const pushMessage = (message: ChatMessage, mapped: Anthropic.MessageParam): void => {
    if (breakpoints.has(message.id) && Array.isArray(mapped.content) && mapped.content.length > 0) {
      const last = mapped.content.length - 1;
      mapped.content[last] = { ...mapped.content[last], cache_control: { type: "ephemeral" } } as typeof mapped.content[number];
    }
    result.push(mapped);
  };
  for (const message of messages) {
    // 上一条 assistant 的 tool_use 结果未随 tool 消息到达（中断未落盘）：先补占位 user 消息
    if (message.role !== "tool" && pendingCallIds.length > 0) {
      result.push({ role: "user", content: placeholderResults(pendingCallIds) });
      pendingCallIds = [];
    }
    if (message.role === "tool") {
      const content: Anthropic.ContentBlockParam[] = message.content
        .filter((block): block is ToolResultContent => block.type === "tool_result" && knownCallIds.has(block.toolCallId) && emittedCallIds.has(block.toolCallId))
        .map((block) => ({
          type: "tool_result" as const,
          tool_use_id: block.toolCallId,
          content: anthropicToolResultContent(block.content, toolMedia.get(block.toolCallId)) as NonNullable<Anthropic.ToolResultBlockParam["content"]>,
          ...(block.isError ? { is_error: true } : {}),
        }));
      // 该批次缺失结果的 tool_use 补占位（同一 assistant 批次的 tool 消息可能多条）
      const covered = new Set(content.map((block) => (block as { tool_use_id: string }).tool_use_id));
      content.push(...placeholderResults(pendingCallIds.filter((id) => !covered.has(id))));
      pendingCallIds = [];
      // 全孤儿（无已知 tool_use）时跳过整条，避免空 content user 消息触发 400
      if (content.length === 0) continue;
      pushMessage(message, { role: "user", content });
    } else if (message.role === "user") {
      pushMessage(message, {
        role: "user",
        content: message.content.flatMap((block): Anthropic.ContentBlockParam[] => {
          if (block.type === "text") return [{ type: "text" as const, text: block.text }];
          // ref 形态（chat 落盘图）由调用方内联为 data 后才进 provider；缺 data 的块跳过
          if (block.type === "image" && block.data) {
            return [{
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: block.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: block.data,
              },
            }];
          }
          return [];
        }),
      });
    } else {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        // 同一 id 在多条 assistant 消息重复出现时只发一次（重复 tool_use id 会被端点拒绝）
        else if (block.type === "tool_call" && !emittedCallIds.has(block.id)) {
          emittedCallIds.add(block.id);
          pendingCallIds.push(block.id);
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        } else if (block.type === "thinking" && block.provider === "anthropic" && block.redacted) {
          // redacted_thinking 原样回传（见 streamChat 的持久化）
          content.push({ type: "redacted_thinking", data: block.redacted });
        } else if (block.type === "thinking" && block.provider === "anthropic" && block.signature) {
          content.push({ type: "thinking", thinking: block.text, signature: block.signature });
        }
      }
      if (content.length === 0) {
        // 跨 provider 切换后 assistant 消息可能只剩异源 thinking 块（映射后为空）；
        // Anthropic 拒绝空 content（400），补占位文本
        content.push({ type: "text", text: "[context trimmed]" });
      }
      pushMessage(message, { role: "assistant", content });
    }
  }
  // 历史以悬空 tool_use 结尾（中断后无后续消息）：补占位结果，保证末条为 user
  if (pendingCallIds.length > 0) result.push({ role: "user", content: placeholderResults(pendingCallIds) });
  return result;
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
