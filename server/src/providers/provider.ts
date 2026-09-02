import type { EffortLevel, ThinkingMode, ThinkingStyle } from "../context/model-profile.js";
import type { ChatMessage } from "../sessions/types.js";
import { ConcurrencyLimitedProvider, type ProviderConcurrencyStats } from "./concurrency-limiter.js";

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StreamChatRequest {
  model: string;
  thinking?: ThinkingMode;
  effort?: EffortLevel;
  /** 思考方式声明（模型目录 capabilities.thinkingStyle 下发；未声明时 openai 兼容路径
   * 只发 effort、anthropic 路径按模型名推断）。provider 按此分发各端点思考参数 key。 */
  thinkingStyle?: ThinkingStyle;
  /** Per-request output ceiling used by internal fast-model calls. */
  maxTokens?: number;
  /** 采样温度（请求级，chat 模式助手预设/会话配置下发）；undefined 时由端点默认决定。 */
  temperature?: number;
  /** nucleus 采样 top_p（请求级）；与 temperature 同通道下发。 */
  topP?: number;
  /** 稳定系统前缀：同会话连续 turn 应逐字节一致，供 prompt cache 命中。 */
  system: string;
  /** 动态系统尾部（逐 turn 变化的通知等），独立成块以免污染稳定前缀的缓存。 */
  systemSuffix?: string;
  /** prompt cache 开关（请求级，默认开）；关闭时不打任何显式断点。 */
  promptCaching?: boolean;
  /** 思维链回传（请求级，仅 OpenAI 兼容接口生效）：按模型能力声明由 agent 循环下发；
   * undefined 时回落 provider 级配置（默认开）。 */
  reasoningContent?: boolean;
  /** 加密思维链回放（仅 OpenAI Responses 接口生效）：按模型能力声明由 agent 循环下发，
   * true 时 provider 走 dsh same-model 口径（include 参数 + rs_/fc_ id 与 encrypted_content 原样回放）。 */
  responsesEncryptedReplay?: boolean;
  /** 服务端联网搜索（请求级，仅 OpenAI Responses 接口生效）：true 时 Provider 在 tools 中
   * 附加 `{"type":"web_search"}`，由模型服务端执行搜索并回传 server_tool 活动事件。 */
  serverWebSearch?: boolean;
  messages: ChatMessage[];
  /** 消息级断点（消息 id 列表）；Provider 按 API 断点上限（Anthropic ≤4，含 tools/system）截断。 */
  cacheBreakpoints?: string[];
  tools: ProviderTool[];
  signal: AbortSignal;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  /** Responses message item 的 v1 textSignature：{v:1,id,phase?}，落盘供回放 message item
   * id/phase；与 thinking_end 同语义的文本收尾事件（output_item.done 权威文本兜底后发出）。 */
  | { type: "text_end"; text: string; signature?: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; text: string; signature?: string; /** Anthropic redacted_thinking 的密文载荷（此时 text 为空）。 */ redacted?: string }
  /** 工具调用参数流式分片：id 在首个分片就绪后稳定；name 仅在已知时携带；
   * argumentsDelta 是参数 JSON 文本的增量片段（拼接后才是完整 JSON）。 */
  | { type: "tool_call_delta"; id: string; name?: string; argumentsDelta: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; /** OpenAI Responses function_call item 的原始 id（fc_xxx），随块持久化供回放原样回传。 */ itemId?: string }
  /** 服务端工具活动（如 Responses API 的 web_search_call）：工具由模型服务端执行，
   * 无需本地调度；仅用于实时活动展示，不落盘、不参与 stopReason 判定。 */
  | { type: "server_tool"; tool: string; phase: "start" | "update" | "end" }
  /** 服务端联网搜索的完整 web_search_call item（id/status/action，OpenAI Responses
   * output_item.done / completed output 权威值）：随 assistant 消息按块序落盘，回放时
   * 按文档「Pass back as-is；服务端自动恢复搜索结果」原样回传。 */
  | { type: "web_search_call"; item: Record<string, unknown> }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error" };

export interface Provider {
  readonly name: string;
  /** 显式 prompt cache 断点是否启用；undefined 表示该 Provider 无显式断点能力（如自动缓存）。 */
  readonly promptCaching?: boolean | undefined;
  /** 端点接口形态（装配侧已知；与 provider-profiles 的 interfaceType 同词汇表）。
   * 消费方（如 read_media 的视频投递门）按它区分端点能力；未声明（测试 stub 等）按未知处理。 */
  readonly interfaceType?: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | undefined;
  streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  /** 0.5.0 Phase 2：并发限制包装器（用于诊断） */
  private readonly limiters = new Map<string, ConcurrencyLimitedProvider>();

  /**
   * Register a provider.
   * @param maxConcurrent 0.5.0 Phase 2: per-provider 并发上限；超出排队等待。
   *   生产注册路径（provider-profiles-runtime）统一按 DEFAULT_MAX_CONCURRENT（3）接线；
   *   不显式传则不包装（测试/特殊通道用）。
   */
  register(provider: Provider, maxConcurrent?: number): void {
    if (this.providers.has(provider.name)) throw new Error(`Provider ${provider.name} is already registered`);
    if (maxConcurrent !== undefined && maxConcurrent > 0) {
      const limited = new ConcurrencyLimitedProvider(provider, maxConcurrent);
      this.limiters.set(provider.name, limited);
      this.providers.set(provider.name, limited);
    } else {
      this.providers.set(provider.name, provider);
    }
  }

  unregister(name: string): void {
    this.providers.delete(name);
    this.limiters.delete(name);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }

  /** 0.5.0 Phase 2：per-provider 并发与队列深度诊断 */
  concurrencyStats(): Record<string, ProviderConcurrencyStats> {
    const result: Record<string, ProviderConcurrencyStats> = {};
    for (const [name, limiter] of this.limiters) {
      result[name] = limiter.getStats();
    }
    return result;
  }
}
