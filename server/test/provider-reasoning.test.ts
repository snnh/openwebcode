import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import type { StreamChatRequest } from "../src/providers/provider.js";

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

describe("provider reasoning parameters", () => {
  it("translates Anthropic thinking and effort without hard-coded defaults", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    const stream = (body: Record<string, unknown>) => {
      bodies.push(body);
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() { return { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
      };
    };
    (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;

    await drain(provider.streamChat(request({ thinking: "adaptive", effort: "xhigh" })));
    await drain(provider.streamChat(request({ thinking: "disabled" })));
    await drain(provider.streamChat(request({ thinking: "enabled" })));
    await drain(provider.streamChat(request({
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "cached" }], createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "u2", role: "user", content: [{ type: "text", text: "tail" }], createdAt: "2026-01-01T00:00:01.000Z" },
      ],
      cacheBreakpoints: ["u1"],
    })));

    expect(bodies[0]).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect(bodies[1]).not.toHaveProperty("output_config");
    expect(bodies[2]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 16000 } });
    const limited = new AnthropicProvider({ apiKey: "test", maxTokens: 8000 });
    (limited as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    await drain(limited.streamChat(request({ thinking: "enabled" })));
    expect(bodies[4]).toMatchObject({ max_tokens: 8000, thinking: { type: "enabled", budget_tokens: 7999 } });
    expect(bodies[3]).toMatchObject({
      messages: [
        { content: [{ text: "cached", cache_control: { type: "ephemeral" } }] },
        { content: [{ text: "tail" }] },
      ],
    });
  });

  it("sends OpenAI reasoning_effort only when enabled", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await drain(new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetch as typeof globalThis.fetch }).streamChat(request({ effort: "high" })));
    await drain(new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", reasoningEffort: false, fetch: fetch as typeof globalThis.fetch }).streamChat(request({ effort: "high" })));
    expect(bodies[0]).toMatchObject({ reasoning_effort: "high" });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });
});
