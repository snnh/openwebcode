import type { EffortLevel, ThinkingMode } from "../context/model-profile.js";
import type { ChatMessage } from "../sessions/types.js";

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StreamChatRequest {
  model: string;
  thinking?: ThinkingMode;
  effort?: EffortLevel;
  system: string;
  messages: ChatMessage[];
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
  streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.name)) throw new Error(`Provider ${provider.name} is already registered`);
    this.providers.set(provider.name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}
