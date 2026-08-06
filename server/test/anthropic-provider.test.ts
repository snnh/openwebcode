import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("AnthropicProvider 消息映射边界", () => {
  it("只含异源 thinking 块的 assistant 消息补占位 text（空 content 会 400）", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies);
    // 跨 provider 切换后的历史：assistant 只剩 deepseek 的 thinking 块，映射后 content 为空
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "q" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "thinking", text: "异源思考", provider: "deepseek" }],
      },
    ];
    await collect(provider.streamChat(request({ messages })));

    const mapped = (bodies[0]!.messages as Array<Record<string, unknown>>)[1]!;
    expect(mapped.role).toBe("assistant");
    expect(mapped.content).toEqual([{ type: "text", text: "[context trimmed]" }]);
  });

  it("redacted_thinking 块持久化为 thinking_end.redacted 并在下轮原样回传", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies, {
      content: [
        { type: "redacted_thinking", data: "EhdHf8s…encrypted-payload" },
        { type: "text", text: "答" },
      ],
    });

    const events = await collect(provider.streamChat(request()));
    // 密文载荷经 thinking_end 事件透出（agent-runner 据此持久化 redacted 字段）
    expect(events).toContainEqual({ type: "thinking_end", text: "", redacted: "EhdHf8s…encrypted-payload" });

    // 下轮请求：持久化的 redacted thinking 块原样回传，缺块会 400
    const messages: ChatMessage[] = [
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "", redacted: "EhdHf8s…encrypted-payload", provider: "anthropic" },
          { type: "text", text: "答" },
        ],
      },
    ];
    await collect(provider.streamChat(request({ messages })));
    const mapped = (bodies[1]!.messages as Array<Record<string, unknown>>)[0]!;
    expect(mapped.content).toEqual([
      { type: "redacted_thinking", data: "EhdHf8s…encrypted-payload" },
      { type: "text", text: "答" },
    ]);
  });

  it("SDK 内建重试关闭（maxRetries=0）：重试统一收口 retry.ts", () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const client = (provider as unknown as { client: { maxRetries: number } }).client;
    expect(client.maxRetries).toBe(0);
  });
});
