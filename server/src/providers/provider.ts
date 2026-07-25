import type { EffortLevel, ThinkingMode } from "../context/model-profile.js";
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
  /** Per-request output ceiling used by internal fast-model calls. */
  maxTokens?: number;
  /** 稳定系统前缀：同会话连续 turn 应逐字节一致，供 prompt cache 命中。 */
  system: string;
  /** 动态系统尾部（逐 turn 变化的通知等），独立成块以免污染稳定前缀的缓存。 */
  systemSuffix?: string;
  /** prompt cache 开关（请求级，默认开）；关闭时不打任何显式断点。 */
  promptCaching?: boolean;
  messages: ChatMessage[];
  /** 消息级断点（消息 id 列表）；Provider 按 API 断点上限（Anthropic ≤4，含 tools/system）截断。 */
  cacheBreakpoints?: string[];
  tools: ProviderTool[];
  signal: AbortSignal;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; text: string; signature?: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
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
  streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  /** 0.5.0 Phase 2：并发限制包装器（用于诊断） */
  private readonly limiters = new Map<string, ConcurrencyLimitedProvider>();

  /**
   * Register a provider.
   * @param maxConcurrent 0.5.0 Phase 2: per-provider 并发上限（默认 3）；超出排队等待。
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
