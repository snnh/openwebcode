import type { ChatMessage } from "../sessions/types.js";
import { getUserAgent } from "../http.js";
import { readSseData, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./openai-compatible-provider.js";
import { classifyHttpError, normalizeProviderError, parseRetryAfter, ProviderError } from "./provider-error.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

export interface OpenAIResponsesProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL: string;
  /** 显式设置才发送 max_output_tokens；缺省不限制输出长度（端点自行决定）。 */
  maxTokens?: number;
  /** 自定义请求体：浅合并进 responses 请求体，核心字段（model/input/stream/tools 等）优先。 */
  extraBody?: Record<string, unknown>;
  reasoningEffort?: boolean;
  /** 请求 reasoning summary 流（response.reasoning_summary_text.delta → thinking_delta）。
   * 端点不接受 reasoning.summary 字段时可显式 false 关闭。 */
  reasoningContent?: boolean;
  /** SSE 流连续无 data 事件的最大毫秒数（心跳注释不计），超时判为半开连接断开并走重试；<=0 关闭。 */
  streamIdleTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface FunctionCallAccumulator {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * OpenAI Responses API（POST {baseURL}/responses，stream: true）。
 *
 * 与 chat/completions 的差异：tools 为扁平 function 结构；消息历史映射为 input items
 * （function_call / function_call_output）；思维以 reasoning summary 流返回；usage 挂在
 * response.completed 事件上（input_tokens_details.cached_tokens → cacheRead）。
 *
 * prompt caching：Responses 只有自动前缀缓存，无显式断点机制——cacheBreakpoints 在此
 * 为 no-op（如实忽略，不伪造断点），cached_tokens 如实上报。
 *
 * 服务端联网搜索（request.serverWebSearch，请求级）：tools 附加 `{"type":"web_search"}`（DeepSeek 等
 * 端点支持，其他类型内置工具忽略）；web_search_call 状态事件映射为 server_tool 活动
 * （实时展示用，不落盘）。历史不回放 web_search_call 项——端点无状态，搜索结果由
 * 模型在当轮重新获取，assistant 文本已含其结论。
 */
export class OpenAIResponsesProvider implements Provider {
  readonly name: string;
  private readonly fetch: typeof fetch;
  private readonly maxTokens: number | undefined;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.name = options.name ?? "openai-responses";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxTokens = options.maxTokens;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    let response: Response;
    const maxTokens = request.maxTokens ?? this.maxTokens;
    // 思维摘要流开关：请求级（模型能力声明）优先，回落 provider 级配置（默认开）
    const reasoningSummary = request.reasoningContent ?? (this.options.reasoningContent !== false);
    const reasoning: Record<string, unknown> = {};
    if (this.options.reasoningEffort !== false && request.effort) reasoning.effort = request.effort;
    if (reasoningSummary) reasoning.summary = "auto";
    // system 组装：稳定前缀 + 动态尾部（Responses 无 system 角色，统一进 instructions）
    const suffix = request.systemSuffix?.trim();
    const instructions = suffix ? `${request.system}\n\n${suffix}` : request.system;
    try {
      response = await this.fetch(`${this.options.baseURL.replace(/\/$/, "")}/responses`, {
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
          instructions,
          input: toResponsesInput(request.messages),
          ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
          ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
          ...(request.tools.length > 0 || request.serverWebSearch === true
            ? {
                tools: [
                  // Responses 扁平 function 结构（区别于 chat 的 nested function 格式）
                  ...request.tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  })),
                  // 服务端联网搜索工具：DeepSeek 等端点在服务端执行并回传 web_search_call 项
                  ...(request.serverWebSearch === true ? [{ type: "web_search" }] : []),
                ],
              }
            : {}),
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
        `OpenAI Responses provider returned ${response.status}: ${detail}`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    // 以 item_id 聚合 function_call；output_item.added 给 call_id/name，arguments 逐片累积，
    // response.completed 的 output items 作为权威终值兜底（覆盖不流式 arguments 的端点）。
    const calls = new Map<string, FunctionCallAccumulator>();
    let sawRefusal = false;
    let finalStatus: string | null = null;
    let incompleteReason: string | null = null;
    let streamStarted = false;
    try {
      for await (const data of readSseData(response.body, { idleTimeoutMs: this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS })) {
        streamStarted = true;
        if (data === "[DONE]") break;
        const event = JSON.parse(data) as ResponsesStreamEvent;
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) yield { type: "text_delta", text: event.delta };
            break;
          // reasoning summary（官方）与 reasoning text（gpt-oss 等）都归一为 thinking_delta
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            if (event.delta) yield { type: "thinking_delta", text: event.delta };
            break;
          case "response.refusal.delta":
          case "response.refusal.done":
            sawRefusal = true;
            break;
          // 服务端联网搜索（DeepSeek 等）：状态更新映射为 server_tool 活动事件
          case "response.web_search_call.in_progress":
            yield { type: "server_tool", tool: "web_search", phase: "start" };
            break;
          case "response.web_search_call.searching":
            yield { type: "server_tool", tool: "web_search", phase: "update" };
            break;
          case "response.web_search_call.completed":
            yield { type: "server_tool", tool: "web_search", phase: "end" };
            break;
          case "response.output_item.added":
            if (event.item?.type === "function_call") {
              const acc = rememberCall(calls, event.item_id, event.item);
              if (event.item.arguments) acc.arguments = event.item.arguments;
              yield {
                type: "tool_call_delta",
                id: acc.callId,
                ...(acc.name ? { name: acc.name } : {}),
                argumentsDelta: "",
              };
            }
            break;
          case "response.function_call_arguments.delta": {
            const acc = rememberCall(calls, event.item_id);
            acc.arguments += event.delta ?? "";
            yield {
              type: "tool_call_delta",
              id: acc.callId,
              ...(acc.name ? { name: acc.name } : {}),
              argumentsDelta: event.delta ?? "",
            };
            break;
          }
          case "response.function_call_arguments.done": {
            const acc = rememberCall(calls, event.item_id);
            if (event.arguments !== undefined) acc.arguments = event.arguments;
            break;
          }
          case "response.output_item.done":
            // output_item.done 的 item 携带完整 name/arguments，作为权威值覆盖流式累积
            if (event.item?.type === "function_call") {
              const acc = rememberCall(calls, event.item_id, event.item);
              if (event.item.arguments !== undefined) acc.arguments = event.item.arguments;
            }
            break;
          case "response.completed":
          case "response.incomplete": {
            const resp = event.response;
            finalStatus = resp?.status ?? finalStatus;
            incompleteReason = resp?.incomplete_details?.reason ?? incompleteReason;
            for (const item of resp?.output ?? []) {
              if (item.type === "function_call") {
                const acc = rememberCall(calls, item.id, item);
                if (item.arguments !== undefined) acc.arguments = item.arguments;
              }
            }
            const usage = resp?.usage;
            if (usage) {
              const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
              if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > usage.input_tokens) {
                throw new Error("OpenAI Responses provider returned invalid cached token usage");
              }
              yield {
                type: "usage",
                inputTokens: usage.input_tokens - cachedTokens,
                outputTokens: usage.output_tokens,
                cacheRead: cachedTokens,
                cacheWrite: 0,
              };
            }
            break;
          }
          case "response.failed": {
            finalStatus = "failed";
            const failure = event.response?.error;
            throw new ProviderError(
              "unknown",
              `OpenAI Responses provider stream failed: ${failure?.message ?? event.message ?? "unknown error"}`,
              false,
            );
          }
          case "error":
            throw new ProviderError("unknown", `OpenAI Responses provider stream error: ${event.message ?? "unknown error"}`, false);
          default:
            break;
        }
      }
    } catch (error) {
      throw normalizeProviderError(error, streamStarted);
    }

    for (const call of calls.values()) {
      yield {
        type: "tool_call",
        id: call.callId,
        name: call.name,
        input: parseArguments(call.arguments),
      };
    }
    yield { type: "done", stopReason: mapStopReason(finalStatus, incompleteReason, sawRefusal, calls.size > 0) };
  }
}

function rememberCall(
  calls: Map<string, FunctionCallAccumulator>,
  itemId: string | undefined,
  item?: { id?: string; call_id?: string; name?: string; arguments?: string },
): FunctionCallAccumulator {
  const key = itemId ?? item?.id ?? `unknown-${calls.size}`;
  let acc = calls.get(key);
  if (!acc) {
    acc = { callId: item?.call_id ?? key, name: item?.name ?? "", arguments: "" };
    calls.set(key, acc);
  }
  if (item?.call_id) acc.callId = item.call_id;
  if (item?.name) acc.name = item.name;
  return acc;
}

/**
 * ChatMessage 历史 → Responses input items。
 * assistant 的 thinking 块不回传：Responses 的 reasoning 回放依赖服务端 reasoning item /
 * encrypted_content（store/previous_response_id 机制），裸文本回放无意义且多数实现不回传。
 *
 * 配对修复：历史可能残留无对应 function_call_output 的 function_call（中断/崩溃时结果
 * 未落盘），Responses API 对此直接 400（"No tool output found for tool call"）；故先
 * 收集 tool_result 映射，function_call 紧随其后内联对应 output，缺失时补占位 output。
 * 游离 tool_result（对应调用在压缩边界外/旧分支）不产出 function_call，直接丢弃，
 * 否则同样报 "No tool call found for function call output"。
 */
function toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const outputs = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && !outputs.has(block.toolCallId)) outputs.set(block.toolCallId, block.content);
    }
  }
  const result: Array<Record<string, unknown>> = [];
  const emitted = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const images = message.content.filter((block) => block.type === "image");
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      // 无图时维持纯字符串 content（Responses 接受字符串简写）；有图时走 parts 数组
      result.push({
        role: "user",
        content: images.length === 0
          ? text
          : [
              ...images.map((block) => ({ type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` })),
              { type: "input_text", text },
            ],
      });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) result.push({ role: "assistant", content: text });
      for (const block of message.content) {
        if (block.type === "tool_call") {
          // 同一 call_id 在多条 assistant 消息重复出现时只 inline 一次：
          // 重复的 function_call/_output 对会被 Responses API 拒绝。
          if (emitted.has(block.id)) continue;
          emitted.add(block.id);
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          result.push({
            type: "function_call_output",
            call_id: block.id,
            output: outputs.get(block.id) ?? "The run was interrupted before this tool finished; no result was produced.",
          });
        }
      }
    }
    // tool 角色消息的 tool_result 已内联到对应 function_call 之后，游离者丢弃（见上文）
  }
  return result;
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function mapStopReason(
  status: string | null,
  incompleteReason: string | null,
  sawRefusal: boolean,
  hasToolCalls: boolean,
): "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error" {
  if (status === "incomplete" && incompleteReason === "max_output_tokens") return "max_tokens";
  if (status === "failed") return "error";
  if (sawRefusal) return "refusal";
  if (hasToolCalls) return "tool_use";
  if (status === "completed") return "end_turn";
  // 流结束但没有 completed/incomplete 终态：按异常处理
  return "error";
}

interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  message?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
    output?: Array<{
      id?: string;
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
    } | null;
  };
}
