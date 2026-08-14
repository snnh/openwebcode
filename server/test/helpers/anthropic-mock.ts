import type { AnthropicProvider } from "../../src/providers/anthropic-provider.js";

interface MockStreamOptions {
  /** finalMessage 的 usage；缺省 { input_tokens: 0, output_tokens: 0 }。 */
  usage?: Record<string, unknown>;
  /** finalMessage 的 content；缺省 []。 */
  content?: unknown[];
  /** finalMessage 的 stop_reason；缺省 "end_turn"。 */
  stopReason?: string;
}

/**
 * 注入 client.messages.stream mock：捕获请求体到 bodies，事件流为空，
 * finalMessage 返回可注入的 usage/content/stop_reason。
 */
export function injectMockStream(provider: AnthropicProvider, bodies: Array<Record<string, unknown>>, options: MockStreamOptions = {}): void {
  const finalMessage = {
    content: options.content ?? [],
    usage: options.usage ?? { input_tokens: 0, output_tokens: 0 },
    stop_reason: options.stopReason ?? "end_turn",
  };
  const stream = (body: Record<string, unknown>) => {
    bodies.push(body);
    return {
      async *[Symbol.asyncIterator]() {},
      async finalMessage() { return finalMessage; },
    };
  };
  (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
}
