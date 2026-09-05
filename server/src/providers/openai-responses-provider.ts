import type { ChatMessage, ImageContent, TextContent, ThinkingContent, ToolCallContent } from "../sessions/types.js";
import { readSseData, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./openai-compatible-provider.js";
import { normalizeProviderError, ProviderError } from "./provider-error.js";
import { parseReasoningSignature, parseWebSearchCallSignature, encodeTextSignatureV1, parseTextSignature, deriveMessageItemId } from "./responses-replay.js";
import { collectToolOutputs, parseArguments, providerRequestHeaders, requireResponseBody } from "./shared.js";
import { collectToolMedia, openaiResponsesMediaMessage, type ToolMediaItem } from "./tool-result-media.js";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

/** OpenAI Responses 拒绝低于 16 的 max_output_tokens（dsh 同口径）。 */
export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

interface OpenAIResponsesProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL: string;
  /** 显式设置才发送 max_output_tokens；缺省不限制输出长度（端点自行决定）。低于 16 会被抬升到 16。 */
  maxTokens?: number;
  /** store 开关（缺省 false，按 dsh 口径 store:false 服务端无状态、状态由本地回放维护）；
   * 端点不接受该字段时可由档案显式配置覆盖。 */
  store?: boolean;
  /** 自定义请求体：浅合并进 responses 请求体，核心字段（model/input/stream/tools 等）优先。 */
  extraBody?: Record<string, unknown>;
  reasoningEffort?: boolean;
  /** 思维链开关（缺省开）：请求 reasoning summary 流（response.reasoning_summary_text.delta /
   * response.reasoning_text.delta → thinking_delta），并控制历史同源 thinking 块的 reasoning
   * item 回传（DeepSeek 思维模式强制要求回传）。端点不接受时可显式 false 关闭。 */
  reasoningContent?: boolean;
  /** SSE 流连续无 data 事件的最大毫秒数（心跳注释不计），超时判为半开连接断开并走重试；<=0 关闭。 */
  streamIdleTimeoutMs?: number;
  fetch?: typeof fetch;
  /** 诊断留痕输出目标（测试注入用；缺省写 stderr）。构造期注入，引用关系创建时确定。 */
  diagnosticWriter?: (line: string) => void;
}

interface FunctionCallAccumulator {
  callId: string;
  /** function_call item 的原始 id（fc_xxx）：随 tool_call 事件透传落盘供诊断/升级固化；
   * 回放时按 DeepSeek Harness 同口径不派发 item id（避免触发配对校验）。 */
  itemId?: string;
  name: string;
  arguments: string;
}

/** 流内 reasoning item 累积：output_item.added/delta 分片累积，output_item.done 收尾成
 * 完整 item，经 thinking_end 事件随 signature 持久化；回放时从 signature 提取纯文本
 * reasoning_text 分片（DeepSeek 输入只支持 plain-text content）。 */
interface ReasoningAccumulator {
  id?: string;
  text: string;
}

/**
 * OpenAI Responses API（POST {baseURL}/responses，stream: true）。
 *
 * 与 chat/completions 的差异：tools 为扁平 function 结构；消息历史映射为 input items
 * （function_call / function_call_output / message）；思维以 reasoning summary / reasoning text
 * 流返回；usage 挂在 response.completed 事件上（input_tokens_details.cached_tokens →
 * cacheRead，cache_write_tokens → cacheWrite）。
 *
 * 无状态：请求体固定带 store:false（dsh 口径，服务端不存状态，多轮上下文完全由本地
 * 回放维护）；max_output_tokens 显式设置时不低于 16（dsh OPENAI_RESPONSES_MIN_OUTPUT_TOKENS）。
 *
 * 加密回放模式（request.responsesEncryptedReplay，官方 OpenAI same-model 口径）：请求体带
 * include:["reasoning.encrypted_content"]（仅当请求了 reasoning summary 或 effort），历史
 * 同源 thinking 块的完整 reasoning item（含 rs_ id/encrypted_content）原样回放、文本块按
 * textSignature 还原 message item（msg_ id/phase）、function_call 保留 fc_ item id，不做
 * DeepSeek 那套纯文本剥离与占位兜底。
 *
 * 思维链回传（request.reasoningContent，非加密/DeepSeek 口径）：开启时历史同源 thinking
 * 块合并为纯文本 reasoning_text 分片，按规范序回放——reasoning item 置于其归属的 assistant
 * message item 之前（文档「Plain-text content is merged into the adjacent assistant message」，
 * 真机验证：旧布局 [message, reasoning, fc] 立即 400，规范序 [reasoning, message, fc] 通过；
 * 带 tools 参数时含思考的所有轮次均需回传，含无 tool_call 的最终回答轮）。流式端持久化的
 * 原始 item signature 只取内容，不原样回放 id/status/summary/encrypted_content；function_call
 * 不派发 item id（call_id 已足够，派生/复制的 id 反而会触发端点配对校验）。缺同源 thinking
 * 素材的普通轮不回传（真机验证无需占位）；仅当输入最后一条是 assistant 消息且无任何 thinking
 * 素材时补占位（DeepSeek 对尾部 assistant 无 reasoning 直接 400，诚实的占位是唯一出路）。
 *
 * prompt caching：Responses 只有自动前缀缓存，无显式断点机制——cacheBreakpoints 在此
 * 为 no-op（如实忽略，不伪造断点），cached_tokens 如实上报。
 *
 * 服务端联网搜索（request.serverWebSearch，请求级）：tools 附加 `{"type":"web_search"}`（DeepSeek 等
 * 端点支持，其他类型内置工具忽略）；web_search_call 状态事件映射为 server_tool 活动
 * （实时展示用），完整 item（id/status/action）经 web_search_call 事件落盘为消息块，
 * 回放时按文档「Pass back as-is；服务端自动恢复搜索结果」原样回传（真机验证 200）。
 *
 * 流式收尾：message output_item.done 以权威文本兜底 delta 后发 text_end（signature 为 v1
 * textSignature，落盘供回放 message item id/phase）；reasoning output_item.done 发 thinking_end
 * （signature 为完整原始 item）；response.completed/incomplete 的 output 携带 encrypted_content
 * 而持久化签名缺失时，补发第二次 thinking_end 合并密文（B3 回填，Azure 等端点只在该终态给
 * 密文）；Azure 漏发 output_item.done content 时由 completed output 兜底收尾。
 */
export class OpenAIResponsesProvider implements Provider {
  readonly name: string;
  readonly interfaceType = "openai-responses" as const;
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
    // 加密回放模式（官方 OpenAI same-model 口径）：请求 reasoning.encrypted_content，历史
    // reasoning/message/function_call item 按原始结构原样回放（含 rs_/fc_ id）
    const encrypted = request.responsesEncryptedReplay === true;
    // 思维摘要流开关：请求级（模型能力声明）优先，回落 provider 级配置（默认开）
    const reasoningSummary = request.reasoningContent ?? (this.options.reasoningContent !== false);
    const reasoning: Record<string, unknown> = {};
    if (this.options.reasoningEffort !== false && request.effort) reasoning.effort = request.effort;
    // 思考关闭按声明分发：thinking 型（deepseek 等）→ reasoning.effort:"none"（Responses 无
    // thinking 开关语法，none 禁用思考模式）；fixed 用户显式选择仍尝试发送；其余无表达不发。
    // 值不设限：effort 值原样（含映射前值），key 由模型目录声明决定。
    if (request.thinking === "disabled" && (request.thinkingStyle === "thinking" || request.thinkingStyle === "fixed")) {
      reasoning.effort = "none";
    }
    // A number of Responses gateways (including simple OpenAI-compatible proxies) do not
    // implement the optional summary field even though they accept /responses itself.
    // Only request summaries when the caller explicitly selected a reasoning effort;
    // plain Responses requests remain compatible with the minimal documented payload.
    if (reasoningSummary && request.effort !== undefined) reasoning.summary = "auto";
    // system 组装：稳定前缀 + 动态尾部（Responses 无 system 角色，统一进 instructions）
    const suffix = request.systemSuffix?.trim();
    const instructions = suffix ? `${request.system}\n\n${suffix}` : request.system;
    try {
      response = await this.fetch(`${this.options.baseURL.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: providerRequestHeaders(this.options.apiKey),
        body: JSON.stringify({
          ...this.options.extraBody,
          model: request.model,
          stream: true,
          // 仅在配置显式指定时发送 store。部分 Responses 兼容端点不认识该字段，
          // 默认省略可避免无意义的 400；本地回放仍由 input 完整维护上下文。
          ...(this.options.store === undefined ? {} : { store: this.options.store }),
          instructions,
          input: toResponsesInput(request.messages, this.name, reasoningSummary, this.options.diagnosticWriter ?? defaultDiagnosticWriter, encrypted),
          // dsh 口径：max_output_tokens 显式设置时不低于 16（OpenAI 拒绝更小值）
          ...(maxTokens !== undefined ? { max_output_tokens: Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) } : {}),
          // 加密回放模式请求 reasoning.encrypted_content：include 与 reasoning 开关/effort 绑定
          // （dsh 条件：include 紧随 reasoning effort/summary 下发）
          ...(encrypted && (reasoningSummary || request.effort !== undefined) ? { include: ["reasoning.encrypted_content"] } : {}),
          // 请求级采样参数：Responses 的推理档（请求携带 effort）拒绝 temperature/top_p，
          // 此时不下发，避免 400；非推理请求按请求级配置透传
          ...(request.effort === undefined && request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.effort === undefined && request.topP !== undefined ? { top_p: request.topP } : {}),
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
    const body = await requireResponseBody(response, "OpenAI Responses provider");

    // 以 item_id 聚合 function_call；output_item.added 给 call_id/name，arguments 逐片累积，
    // response.completed 的 output items 作为权威终值兜底（覆盖不流式 arguments 的端点）。
    const calls = new Map<string, FunctionCallAccumulator>();
    // reasoning item 按 output_index 聚合：added 开槽、delta 累积、done 收尾 emit thinking_end
    // （携带完整 item 的 signature，供 agent 持久化后原样回放——思维模式端点强制回传）。
    const reasoningAccums = new Map<number, ReasoningAccumulator>();
    // message 文本按 output_index 聚合：delta 累积进槽位，done 以权威 item 文本兜底后发 text_end
    // （signature 为 v1 textSignature，落盘供回放 message item id/phase）。
    const textAccums = new Map<number, { text: string }>();
    // 已收尾 reasoning item（id → 文本/signature）：B3 回填用——completed output 携带
    // encrypted_content 而持久化签名缺失时，合并密文补发第二次 thinking_end。
    const reasoningFinished = new Map<string, { text: string; signature: string }>();
    // 已收尾 web_search_call item（id → 完整 item）：completed output 兜底用——个别端点
    // output_item.done 缺失时由终态权威输出补发 web_search_call 事件（与 B3 同思路）。
    const webSearchFinished = new Map<string, Record<string, unknown>>();
    let sawRefusal = false;
    let sawText = false;
    // 是否收到显式流结束哨兵（[DONE]）：用于区分「端点不发终态但正常收尾」与
    // 「连接被截断/代理中断」——后者必须保持 error 以走 collectProviderTurn 重试。
    let sawStreamEnd = false;
    let finalStatus: string | null = null;
    let incompleteReason: string | null = null;
    let streamStarted = false;
    try {
      for await (const data of readSseData(body, { idleTimeoutMs: this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS })) {
        streamStarted = true;
        if (data === "[DONE]") {
          sawStreamEnd = true;
          break;
        }
        const event = JSON.parse(data) as ResponsesStreamEvent;
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta) {
              sawText = true;
              if (event.output_index !== undefined) {
                // 开槽或续写文本槽位（output_item.added 未到/缺失时兜底）
                const acc = textAccums.get(event.output_index) ?? { text: "" };
                acc.text += event.delta;
                textAccums.set(event.output_index, acc);
              }
              yield { type: "text_delta", text: event.delta };
            }
            break;
          // reasoning summary（官方）与 reasoning text（gpt-oss 等）都归一为 thinking_delta；
          // 同步累积进 reasoning 槽位，output_item.done 收尾时作为 thinking_end 的完整文本
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            if (event.delta) {
              if (event.output_index !== undefined) {
                const acc = reasoningAccums.get(event.output_index) ?? { text: "" };
                acc.text += event.delta;
                reasoningAccums.set(event.output_index, acc);
              }
              yield { type: "thinking_delta", text: event.delta };
            }
            break;
          }
          // summary part 完结：追加空行分隔（与 reasoning_text 分片拼成独立摘要段落）
          case "response.reasoning_summary_part.done": {
            if (event.output_index !== undefined) {
              const acc = reasoningAccums.get(event.output_index) ?? { text: "" };
              acc.text += "\n\n";
              reasoningAccums.set(event.output_index, acc);
            }
            yield { type: "thinking_delta", text: "\n\n" };
            break;
          }
          case "response.refusal.delta":
            sawRefusal = true;
            // refusal 与 output_text 同属 message 文本槽位：累积并在收尾时计入权威文本
            if (event.delta) {
              if (event.output_index !== undefined) {
                const acc = textAccums.get(event.output_index) ?? { text: "" };
                acc.text += event.delta;
                textAccums.set(event.output_index, acc);
              }
              yield { type: "text_delta", text: event.delta };
            }
            break;
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
              const acc = rememberCall(calls, event.item_id, event.item, event.output_index);
              if (event.item.arguments) acc.arguments = event.item.arguments;
              yield {
                type: "tool_call_delta",
                id: acc.callId,
                ...(acc.name ? { name: acc.name } : {}),
                argumentsDelta: "",
              };
            } else if (event.item?.type === "reasoning" && event.output_index !== undefined) {
              // 开槽：后续 reasoning_text.delta 累积进该槽位，done 时收尾 emit thinking_end
              reasoningAccums.set(event.output_index, { text: "", ...(event.item.id ? { id: event.item.id } : {}) });
            } else if (event.item?.type === "message" && event.output_index !== undefined) {
              // 开槽：后续 output_text/refusal delta 累积进该槽位，done 时发 text_end
              textAccums.set(event.output_index, { text: "" });
            }
            break;
          case "response.function_call_arguments.delta": {
            const acc = rememberCall(calls, event.item_id, undefined, event.output_index);
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
            const acc = rememberCall(calls, event.item_id, undefined, event.output_index);
            if (event.arguments !== undefined) acc.arguments = event.arguments;
            break;
          }
          case "response.output_item.done":
            // output_item.done 的 item 携带完整 name/arguments，作为权威值覆盖流式累积
            if (event.item?.type === "function_call") {
              const acc = rememberCall(calls, event.item_id, event.item, event.output_index);
              if (event.item.arguments !== undefined) acc.arguments = event.item.arguments;
            } else if (event.item?.type === "web_search_call") {
              // 服务端联网搜索收尾：完整 item（id/status/action）落盘为消息块，回放时
              // 按文档原样回传（服务端自动恢复搜索结果）；重复 id 只发一次（completed 兜底去重）。
              if (event.item.id !== undefined && !webSearchFinished.has(event.item.id)) {
                webSearchFinished.set(event.item.id, event.item);
                yield { type: "web_search_call", item: event.item };
              }
            } else if (event.item?.type === "reasoning" && event.output_index !== undefined) {
              // 收尾：完整 item（含 id/content）经 thinking_end 的 signature 持久化，回放时
              // 原样还原（思维模式端点强制 reasoning_text 完整回传，缺 id/结构会 400）。
              const acc = reasoningAccums.get(event.output_index);
              reasoningAccums.delete(event.output_index);
              const summaryText = (event.item.summary ?? []).map((s) => s.text ?? "").join("\n\n");
              const contentText = (event.item.content ?? [])
                .filter((part) => part?.type === "reasoning_text")
                .map((part) => part.text ?? "")
                .join("\n\n");
              const text = summaryText || contentText || acc?.text || "";
              const signature = JSON.stringify(event.item);
              if (event.item.id) reasoningFinished.set(event.item.id, { text, signature });
              yield { type: "thinking_end", text, signature };
            } else if (event.item?.type === "message" && event.output_index !== undefined) {
              // 文本收尾：以 output_item.done 的权威 item 文本兜底 delta（覆盖不流式/截断 delta
              // 的端点），随后发 text_end（signature 为 v1 textSignature，落盘供回放 message item）
              const acc = textAccums.get(event.output_index);
              textAccums.delete(event.output_index);
              const accumulated = acc?.text ?? "";
              const authoritative = (event.item.content ?? [])
                .filter((part) => part?.type === "output_text" || part?.type === "refusal")
                .map((part) => (part?.type === "refusal" ? part.refusal ?? "" : part.text ?? ""))
                .join("");
              if (authoritative.startsWith(accumulated)) {
                // 权威比累积更长且前缀一致 → 只补发后缀 delta（常见：剩余文本仅在 done 给出）
                if (authoritative.length > accumulated.length) {
                  yield { type: "text_delta", text: authoritative.slice(accumulated.length) };
                }
              } else if (authoritative !== accumulated && !(accumulated.startsWith(authoritative) && accumulated.length > authoritative.length)) {
                // 累积与权威完全不同（端点重发/替换内容）：不重发完整文本（会造成流式重复），
                // 由 text_end 兜底权威值；累积为权威前缀（被截断）时同样不重发，text_end 以权威为准
              }
              yield {
                type: "text_end",
                text: authoritative || accumulated,
                ...(event.item.id ? { signature: encodeTextSignatureV1(event.item.id, event.item.phase) } : {}),
              };
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
              } else if (item.type === "web_search_call" && item.id !== undefined) {
                // 兜底：个别端点 output_item.done 未携带 web_search_call item，仅 completed
                // output 里有——补发事件（幂等：done 已发过则跳过）。
                if (!webSearchFinished.has(item.id)) {
                  webSearchFinished.set(item.id, item);
                  yield { type: "web_search_call", item };
                }
              } else if (item.type === "reasoning" && item.id !== undefined) {
                const finished = reasoningFinished.get(item.id);
                if (finished) {
                  // B3 回填：completed output 携带 encrypted_content 而持久化签名缺失时，合并
                  // 密文补发第二次 thinking_end（store:false 多轮回放依赖该密文原样回传）
                  if (item.encrypted_content) {
                    const stored = JSON.parse(finished.signature) as Record<string, unknown>;
                    if (!stored.encrypted_content) {
                      yield {
                        type: "thinking_end",
                        text: finished.text,
                        signature: JSON.stringify({ ...stored, encrypted_content: item.encrypted_content }),
                      };
                    }
                  }
                } else {
                  // 兜底：个别端点（如 Azure）在 output_item.done 不带完整 content，仅
                  // response.completed 的 output 里携带——此时该槽位尚未收尾，补 emit
                  // thinking_end（signature 用权威完整 item）。
                  for (const [index, acc] of reasoningAccums) {
                    if (acc.id === item.id) {
                      const parts = item.content?.filter((part) => part?.type === "reasoning_text");
                      const itemText = parts?.map((part) => part.text ?? "").join("\n\n") ?? "";
                      reasoningAccums.delete(index);
                      yield {
                        type: "thinking_end",
                        text: itemText || acc.text || "",
                        signature: JSON.stringify(item),
                      };
                    }
                  }
                }
              }
            }
            const usage = resp?.usage;
            if (usage) {
              const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
              const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
              if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0) {
                throw new Error("OpenAI Responses provider returned invalid cached token usage");
              }
              if (!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0) {
                throw new Error("OpenAI Responses provider returned invalid cache write token usage");
              }
              yield {
                type: "usage",
                // OpenAI 把 cached/cache-write 计入 input_tokens，减去后可能为负（异常上报），钳到 0
                inputTokens: Math.max(0, usage.input_tokens - cachedTokens - cacheWriteTokens),
                outputTokens: usage.output_tokens,
                cacheRead: cachedTokens,
                cacheWrite: cacheWriteTokens,
              };
            }
            break;
          }
          case "response.failed": {
            finalStatus = "failed";
            const failure = event.response?.error;
            throw responsesStreamFailure("OpenAI Responses provider stream failed", failure?.code, failure?.message ?? event.message);
          }
          case "error":
            throw responsesStreamFailure("OpenAI Responses provider stream error", event.code, event.message);
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
        ...(call.itemId ? { itemId: call.itemId } : {}),
        name: call.name,
        input: parseArguments(call.arguments),
      };
    }
    yield { type: "done", stopReason: mapStopReason(finalStatus, incompleteReason, sawRefusal, calls.size > 0, sawText, sawStreamEnd) };
  }
}

function rememberCall(
  calls: Map<string, FunctionCallAccumulator>,
  itemId: string | undefined,
  item?: { id?: string; call_id?: string; name?: string; arguments?: string },
  /** 稳定兜底键：端点未携带 item_id/item.id 时按输出槽位索引聚合
   * （比 `unknown-${calls.size}` 稳定——size 随增而变会把同一调用的
   * 多次 delta 拆成多条 tool_call）。 */
  outputIndex?: number,
): FunctionCallAccumulator {
  const key = itemId ?? item?.id ?? (outputIndex !== undefined ? `idx-${outputIndex}` : `unknown-${calls.size}`);
  let acc = calls.get(key);
  if (!acc) {
    acc = { callId: item?.call_id ?? key, name: item?.name ?? "", arguments: "" };
    calls.set(key, acc);
  }
  if (item?.call_id) acc.callId = item.call_id;
  if (item?.id) acc.itemId = item.id;
  if (item?.name) acc.name = item.name;
  return acc;
}

/**
 * ChatMessage 历史 → Responses input items。
 *
 * 加密回放模式（encrypted，official OpenAI / dsh same-model 口径）：assistant 消息按原始
 * 块序逐块回放——同源 thinking 块带有效 signature 时把存储的完整 reasoning item（含 rs_
 * id/encrypted_content/summary/content）原样回传；文本块还原完整 message item（msg_ id 取
 * 自 textSignature，缺省派生稳定 id）；tool_call 保留 fc_ item id 并内联 function_call_output。
 * 该模式不做纯文本剥离、不补占位 reasoning（服务端 reasoning↔function_call 的 id 配对由
 * 原样回放维持）。用户消息恒为 parts 数组（input_text/input_image，原始块序）。
 *
 * 思维链回传（replayReasoning，非加密 / DeepSeek 口径，遵循模型目录「思维链回传」能力
 * 声明，与 openai-compatible 的 reasoning_content 回带同一语义）：同源 thinking 块合并为
 * 完整的 reasoning_text content parts，置于其归属的 assistant message item 之前（规范序，
 * 真机验证：reasoning 置于 message 之后立即 400「The reasoning_text in the thinking mode
 * must be passed back to the API」；规范序通过，含无 tool_call 的最终回答轮与多工具调用轮）。
 * 因此回放时只下发 DeepSeek 输入支持的 plain-text content（不带 item id/status/summary/
 * encrypted_content），避免派生 id 触发端点的 reasoning↔function_call 配对校验。
 * 缺同源 thinking 素材的轮（导入历史/旧协议遗留）不回传 reasoning（真机验证规范序下无占位
 * 即通过，占位反而污染思维链）；仅当输入最后一条是 assistant 消息且无任何 thinking 素材时
 * 补占位——DeepSeek 对尾部 assistant 无 reasoning 直接 400（H3/H4/TA2 探针），历史素材
 * 确实不存在，诚实占位是唯一出路。OpenAI 官方端点声明关闭回传（服务端 reasoning item /
 * encrypted_content 机制），不受影响。
 *
 * 配对修复：历史可能残留无对应 function_call_output 的 function_call（中断/崩溃时结果
 * 未落盘），Responses API 对此直接 400（"No tool output found for tool call"）；故先
 * 收集 tool_result 映射，function_call 紧随其后内联对应 output，缺失时补占位 output。
 * 游离 tool_result（对应调用在压缩边界外/旧分支）不产出 function_call，直接丢弃，
 * 否则同样报 "No tool call found for function call output"。
 */
/** 回传被关的留痕限频（按 provider 名键控，避免多 provider 实例/多会话共享一次标记造成漏报）。 */
const replaySuppressedLogged = new Set<string>();

/** 回传开启但历史缺同源 thinking 素材的留痕限频（按「provider:assistant 消息 id:tool_call id」键控，
 * 每进程每键一次）：此类 tool_call 会补一条占位 reasoning item（见 toResponsesInput），
 * 留痕便于诊断导入历史/旧协议遗留；同一条消息反复请求不刷屏，不同消息仍保留诊断留痕。
 * 键按消息 id 派生（长会话/多会话下无上界），故设容量上限——超限清空重新计数，
 * 只影响留痕频率，不影响回放行为。 */
const missingThinkingLogged = new Set<string>();
const MISSING_THINKING_LOG_KEYS_MAX = 1000;

function noteMissingThinking(key: string): boolean {
  if (missingThinkingLogged.has(key)) return false;
  if (missingThinkingLogged.size >= MISSING_THINKING_LOG_KEYS_MAX) missingThinkingLogged.clear();
  missingThinkingLogged.add(key);
  return true;
}

/** 尾部 assistant 消息缺同源 thinking 素材时的占位 reasoning_text（旧协议/导入历史且位于
 * 输入末尾时触发）。DeepSeek 对「输入最后一条是 assistant 且无 reasoning item」直接 400，
 * 历史素材确实不存在，只能诚实标注占位；普通轮次（非尾部）缺素材不回传，真机验证无需占位。 */
export const PLACEHOLDER_REASONING_TEXT = "No reasoning content was recorded for this assistant message.";

/** 缺省诊断留痕输出（stderr）。 */
const defaultDiagnosticWriter = (line: string): void => {
  process.stderr.write(line);
};

/** 工具调用被中断（无 tool_result 落盘）时的 function_call_output 占位输出。 */
const INTERRUPTED_TOOL_OUTPUT = "The run was interrupted before this tool finished; no result was produced.";

/** 替换孤立代理码点（lone surrogate）为 U+FFFD：高/低代理不配对会破坏 JSON 序列化
 * （dsh sanitizeSurrogates 同义，本实现按任务口径用替换而非删除）。合法 emoji 的配对
 * 代理不受影响。 */
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** 从持久化的 reasoning item signature 提取纯文本 reasoning_text 分片；无签名或内容为空
 * 时回落到 thinking 块自身文本（旧数据/导入历史）。signature 只取内容，不原样回放
 * id/status/summary/encrypted_content（DeepSeek 输入仅支持 plain-text content）。 */
function reasoningTextParts(signature: string | undefined, fallbackText: string): Array<{ type: "reasoning_text"; text: string }> {
  const original = parseReasoningSignature(signature);
  const content = original?.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null && part.type === "reasoning_text")
      .filter((part) => typeof part.text === "string" && part.text.trim() !== "")
      .map((part) => ({ type: "reasoning_text" as const, text: part.text as string }));
    if (parts.length > 0) return parts;
  }
  return fallbackText.trim() === "" ? [] : [{ type: "reasoning_text" as const, text: fallbackText }];
}

/** 持久化文本块上可能带有的 textSignature（v1 {v:1,id,phase?}）；sessions/types.ts 的
 * TextContent 尚未声明该字段（后置任务），此处放宽类型只读取，不修改消息结构。 */
type StoredTextBlock = TextContent & { textSignature?: string };

/** web_search_call 块的回放归属：块上记录的 provider 与当前 provider 一致才回传原始 item
 * （换 provider 后把上游端点的 ws_ item 传给另一家会被拒）。旧历史无 provider 字段时
 * 按同源处理——保持既有会话可继续，不因缺字段静默丢内容。 */
function ownsWebSearchBlock(block: { provider?: string }, providerName: string): boolean {
  return block.provider === undefined || block.provider === providerName;
}

/** Responses 网关有两类合法标识：官方通常用 call_id（call_*），部分兼容端点
 * 将 function_call 的 fc_* item id 同时作为 tool output 的 call_id。回放时统一
 * 使用原始 fc_* 标识，避免请求中的 function_call 与 function_call_output 脱配。 */
function responseToolCallId(call: ToolCallContent): string {
  // OpenAI/DeepSeek 均规定 function_call_output.call_id 必须等于
  // function_call.call_id；fc_* 仅是 output item 的 id，不能替代 call_id。
  return call.id;
}

function toResponsesInput(
  messages: ChatMessage[],
  providerName: string,
  replayReasoning: boolean,
  diagnosticWriter: (line: string) => void,
  encrypted: boolean,
): Array<Record<string, unknown>> {
  const outputs = collectToolOutputs(messages);
  const toolMedia = collectToolMedia(messages);
  const result: Array<Record<string, unknown>> = [];
  const emitted = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      // dsh 口径：用户内容恒为 parts 数组，按原始块序（text → input_text；image → input_image）
      const content = message.content
        .filter((block): block is TextContent | (ImageContent & { data: string }) =>
          block.type === "text" || (block.type === "image" && typeof block.data === "string"))
        .map((block) =>
          block.type === "text"
            ? { type: "input_text", text: sanitizeSurrogates(block.text) }
            : { type: "input_image", detail: "auto", image_url: `data:${block.mediaType};base64,${block.data}` },
        );
      if (content.length === 0) continue;
      result.push({ role: "user", content });
    } else if (message.role === "assistant") {
      if (encrypted) {
        // 加密回放模式（official OpenAI，dsh same-model 口径）：按原始块序回放——
        // - 同源 thinking 块：带有效 signature 时把存储的完整 reasoning item（含 rs_ id /
        //   encrypted_content / summary / content）原样回传；无签名直接跳过（不补占位）；
        // - web_search_call 块：服务端原始 item 原样回传（文档：Pass back as-is，服务端自动恢复搜索结果）；
        // - 文本块：完整 message item（msg_ id 取自 textSignature，缺省派生稳定 id）；
        // - tool_call 块：function_call 保留 fc_ item id（itemId 以 fc_ 开头时），随后内联
        //   function_call_output（结果缺失补 interrupted 占位）。
        let textBlockIndex = 0;
        // 附带媒体（read_media）批量收集：本 assistant 消息内全部 function_call_output
        // 之后合成**一条** user 消息投递（fc/fco 配对要求连续，中间插 user 会破配对校验）
        const encryptedMediaBatch: ToolMediaItem[] = [];
        for (const block of message.content) {
          if (block.type === "thinking") {
            if (block.provider !== providerName) continue;
            const original = parseReasoningSignature(block.signature);
            if (original) result.push(original);
            // 无签名 → skip（加密回放不做占位，服务端不需要存在性校验）
          } else if (block.type === "web_search_call") {
            if (!ownsWebSearchBlock(block, providerName)) continue;
            const item = parseWebSearchCallSignature(block.signature);
            if (item) result.push(item);
          } else if (block.type === "text") {
            const textBlock = block as StoredTextBlock;
            const parsedSignature = parseTextSignature(textBlock.textSignature);
            result.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
              status: "completed",
              id: parsedSignature?.id ?? deriveMessageItemId(`${message.id}:${textBlockIndex}`),
              ...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
            });
            textBlockIndex += 1;
          } else if (block.type === "tool_call" && !emitted.has(block.id) && outputs.has(block.id)) {
            emitted.add(block.id);
            const responseCallId = responseToolCallId(block);
            result.push({
              type: "function_call",
              call_id: responseCallId,
              name: block.name,
              arguments: JSON.stringify(block.input),
              // 仅原样回传以 fc_ 开头的官方 item id（其他派生/复制 id 反而触发配对校验）
              ...(block.itemId && block.itemId.startsWith("fc_") ? { id: block.itemId } : {}),
            });
            result.push({
              type: "function_call_output",
              call_id: responseCallId,
              output: sanitizeSurrogates(outputs.get(block.id) ?? INTERRUPTED_TOOL_OUTPUT),
            });
            encryptedMediaBatch.push(...(toolMedia.get(block.id) ?? []));
          }
        }
        if (encryptedMediaBatch.length > 0) result.push(openaiResponsesMediaMessage(encryptedMediaBatch));
      } else {
      // 规范序回放（DeepSeek Responses 官方规则 + 真机验证）：带 tools 的请求中，所有含
      // reasoning_text 的 reasoning item 必须回传，且位于其归属的 assistant 消息之前
      // （"Plain-text content is merged into the adjacent assistant message"）。同一 assistant
      // 消息内的 thinking 块按流式到达顺序逐块回放（reasoning item 与 web_search_call item
      // 交错保持原始结构），随后文本 message item、再逐 function_call 输出
      // function_call + function_call_output（多调用轮不需要 per-call 重复——旧规则是错位
      // 布局下的误判，真机验证规范序单条即过）。缺同源 thinking 素材的轮不回传（真机验证
      // 无需占位；占位反而污染思维链）。仅当整条消息是输入最后一条且无任何 thinking 素材时，
      // 才补占位——真机验证 DeepSeek 对「尾部 assistant 消息无 reasoning」直接 400
      // （The reasoning_text in the thinking mode must be passed back），此时历史素材确实
      // 不存在，只能诚实标注占位。
      const thinkingBlocks = message.content.filter(
        (block): block is ThinkingContent => block.type === "thinking" && block.provider === providerName,
      );
      if (!replayReasoning && !replaySuppressedLogged.has(providerName) && thinkingBlocks.length > 0) {
        // 回传被能力声明关闭但历史含同源 thinking 块：DeepSeek 思维模式会因此 400，留痕便于诊断（每 provider 一次）
        replaySuppressedLogged.add(providerName);
        diagnosticWriter(`[openai-responses] 思维链回传已关闭（reasoningContent=false），历史 thinking 块不会回传；思维模式端点（如 DeepSeek）可能拒绝请求\n`);
      }
      // 规范序前置项：reasoning（逐 thinking 块）与 web_search_call（原样）按消息块原始
      // 顺序交错——两者都属于 assistant 消息的前置内容（流式输出顺序：reasoning/ws → message → fc）。
      const preItems: Array<Record<string, unknown>> = [];
      let hasReasoning = false;
      for (const block of message.content) {
        if (block.type === "thinking" && block.provider === providerName && replayReasoning) {
          const parts = reasoningTextParts(block.signature, block.text);
          if (parts.length > 0) {
            preItems.push({ type: "reasoning", content: parts });
            hasReasoning = true;
          }
        } else if (block.type === "web_search_call" && ownsWebSearchBlock(block, providerName)) {
          const item = parseWebSearchCallSignature(block.signature);
          if (item) preItems.push(item);
        }
      }
      if (preItems.length > 0) result.push(...preItems);
      if (!hasReasoning && replayReasoning && message === messages[messages.length - 1]) {
        // 尾部保护：输入最后一条是 assistant 且历史上无任何 thinking 素材（旧协议/导入历史）时，
        // DeepSeek 仍强制要求 reasoning item（真机验证 400）；诚实的占位是唯一出路。
        result.push({ type: "reasoning", content: [{ type: "reasoning_text", text: PLACEHOLDER_REASONING_TEXT }] });
        const missingKey = `${providerName}:${message.id ?? "?"}:tail`;
        if (noteMissingThinking(missingKey)) {
          diagnosticWriter(
            `[openai-responses] 输入最后一条为 assistant 消息但缺同源 thinking 素材：已补占位 reasoning item（DeepSeek 尾部校验要求）\n`,
          );
        }
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => sanitizeSurrogates(block.text))
        .join("");
      // 同一 call_id 在多条 assistant 消息重复出现时只 inline 一次：
      // 重复的 function_call/_output 对会被 Responses API 拒绝。
      // 不回放没有对应 tool_result 的孤儿调用；伪造 function_call_output 占位会被
      // 严格 Responses 网关拒绝为「No tool output found」。
      const toolCalls = message.content.filter((block): block is ToolCallContent => block.type === "tool_call" && !emitted.has(block.id) && outputs.has(block.id));
      for (const call of toolCalls) emitted.add(call.id);
      if (text) {
        // 完整 message item（id 取自 textSignature，缺省派生稳定 id；与加密路径同构）
        const textBlock = message.content.find((block) => block.type === "text") as StoredTextBlock | undefined;
        const parsedSignature = textBlock ? parseTextSignature(textBlock.textSignature) : undefined;
        result.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
          status: "completed",
          id: parsedSignature?.id ?? deriveMessageItemId(`${message.id}:0`),
          ...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
        });
      }
      // 并行 function_call 全前置（fc…fc → fco…fco，单工具时两者等价）：DeepSeek 服务端
      // 按「归并到相邻 assistant 消息」解析输入 items，逐对排列（fc,fco,fc,fco）会把同一
      // assistant 轮的并行调用拆成多条虚拟轮，第二条起没有归属的 reasoning → 直接 400
      // （真机验证「reasoning_text must be passed back」；全前置排列 200 通过）。
      for (const call of toolCalls) {
        // function_call 只带 call_id（DeepSeek Harness 同口径：不派发 item id，避免触发
        // 服务端 reasoning↔function_call 的 id 配对校验；call_id 与 output 配对已足够）
        result.push({
          type: "function_call",
          call_id: responseToolCallId(call),
          name: call.name,
          arguments: JSON.stringify(call.input),
          // Gateways that expose the Responses item id require it for pairing. Preserve it
          // when it is the same stable identifier used as call_id; omit derived/mismatched
          // ids because those trigger strict reasoning↔function validation on some endpoints.
          // 保留原始 function_call item id；OpenAI 官方允许输入项携带该 id，
          // 兼容网关会用它校验后续 function_call_output 是否属于同一项。
          ...(call.itemId?.startsWith("fc_") ? { id: call.itemId } : {}),
        });
      }
      for (const call of toolCalls) {
        result.push({
          type: "function_call_output",
          call_id: responseToolCallId(call),
          output: sanitizeSurrogates(outputs.get(call.id) ?? INTERRUPTED_TOOL_OUTPUT),
        });
      }
      // 附带媒体（read_media）synthesized user 消息：整批 function_call_output 之后一次投递
      const batchMedia: ToolMediaItem[] = [];
      for (const call of toolCalls) {
        batchMedia.push(...(toolMedia.get(call.id) ?? []));
      }
      if (batchMedia.length > 0) result.push(openaiResponsesMediaMessage(batchMedia));
      }
    }
    // tool 角色消息的 tool_result 已内联到对应 function_call 之后，游离者丢弃（见上文）
  }
  return result;
}

/** 流内失败事件按 code 区分可重试：服务端错误/过载/限流走重试，其余（如 invalid_request）为确定性失败。
 * 前缀匹配兼容端点变体码（rate_limit_exceeded 等），避免高频限流码被判不可重试。 */
function responsesStreamFailure(prefix: string, code: string | undefined, message: string | undefined): ProviderError {
  const normalized = code?.toLowerCase() ?? "";
  const rateLimited = normalized.startsWith("rate_limit");
  const retryable = rateLimited || normalized.startsWith("server_error") || normalized.startsWith("overloaded");
  const kind = rateLimited ? "rate_limit" : retryable ? "overloaded" : "unknown";
  return new ProviderError(kind, `${prefix}: ${message ?? "unknown error"}`, retryable);
}

function mapStopReason(
  status: string | null,
  incompleteReason: string | null,
  sawRefusal: boolean,
  hasToolCalls: boolean,
  sawText: boolean,
  sawStreamEnd: boolean,
): "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error" {
  if (status === "incomplete" && incompleteReason === "max_output_tokens") return "max_tokens";
  if (status === "failed") return "error";
  if (sawRefusal) return "refusal";
  if (hasToolCalls) return "tool_use";
  if (status === "completed") return "end_turn";
  // 没有 completed/incomplete 终态：仅当收到显式结束哨兵（[DONE]）且已有产出时才按正常结束
  // 处理（兼容只发 [DONE] 不发终态的端点）；无哨兵的 EOF 视作连接截断，保持 error 以走重试
  if (sawStreamEnd && sawText) return "end_turn";
  return "error";
}

interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  message?: string;
  /** 输出槽位索引：reasoning/function_call/message 的 output_item 事件按 output_index 聚合
   * （OpenAI 官方 SSE 事件携带；DeepSeek 兼容端点同）。 */
  output_index?: number;
  /** error 事件的失败码（response.failed 的码在 response.error.code 上）。 */
  code?: string;
  item?: {
    id?: string;
    phase?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    /** web_search_call item 的状态/动作（output_item.done 权威值，回放时原样回传）。 */
    status?: string;
    action?: unknown;
    /** reasoning item 的明文思维链分片（output_item.done 携带完整结构）；message item 的
     * 文本分片可能为 output_text（text）或 refusal（refusal）。 */
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
    /** reasoning item 的摘要分片（summary 模式）。 */
    summary?: Array<{ type?: string; text?: string }>;
    /** reasoning item 的密文思维链（请求 include:["reasoning.encrypted_content"] 时返回）。 */
    encrypted_content?: unknown;
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
      /** web_search_call item 的状态/动作（completed 权威终值）。 */
      status?: string;
      action?: unknown;
      /** reasoning item 的明文思维链分片（completed 权威终值）。 */
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
      /** reasoning item 的密文思维链（Azure 等端点只在 completed output 提供）。 */
      encrypted_content?: unknown;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    } | null;
  };
}
