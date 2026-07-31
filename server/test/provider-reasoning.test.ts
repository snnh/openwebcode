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

  it("omits an empty tools field instead of advertising an unavailable tool schema", async () => {
    const anthropicBodies: Array<Record<string, unknown>> = [];
    const anthropic = new AnthropicProvider({ apiKey: "test" });
    const stream = (body: Record<string, unknown>) => {
      anthropicBodies.push(body);
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() { return { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
      };
    };
    (anthropic as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    await drain(anthropic.streamChat(request()));

    const openAiBodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      openAiBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await drain(new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetch as typeof globalThis.fetch }).streamChat(request()));

    expect(anthropicBodies[0]).not.toHaveProperty("tools");
    expect(openAiBodies[0]).not.toHaveProperty("tools");
  });

  it("replays same-provider thinking blocks as reasoning_content (思维链保留回传)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "q" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "先想第一步", provider: "zijian" },
          { type: "thinking", text: "再想想", provider: "zijian" },
          { type: "thinking", text: "异源思考", provider: "anthropic" },
          { type: "text", text: "答" },
          { type: "tool_call", id: "tc1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "tc1", content: "ok", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    const make = (options: Record<string, unknown> = {}) =>
      new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", name: "zijian", fetch: fetch as typeof globalThis.fetch, ...options });

    // 默认开启：同源 thinking 回放 reasoning_content（含 tool_calls 消息），异源不回带
    await drain(make().streamChat(request({ messages })));
    const assistant = (bodies[0]!.messages as Array<Record<string, unknown>>)[2]!;
    expect(assistant.reasoning_content).toBe("先想第一步\n再想想");
    expect(assistant.tool_calls).toHaveLength(1);

    // reasoningContent: false 关闭回传，消息形态与旧版一致
    await drain(make({ reasoningContent: false }).streamChat(request({ messages })));
    const legacy = (bodies[1]!.messages as Array<Record<string, unknown>>)[2]!;
    expect(legacy).not.toHaveProperty("reasoning_content");

    // 无异名 thinking 块时消息形态不变（回归）
    await drain(make().streamChat(request()));
    expect((bodies[2]!.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty("reasoning_content");
  });
});


describe("provider custom request body (extraBody)", () => {
  const sseFetch = (bodies: Array<Record<string, unknown>>) => (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;

  it("omits max_tokens by default and merges extraBody under core fields", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(new OpenAICompatibleProvider({
      baseURL: "https://example.invalid/v1",
      extraBody: { temperature: 0.7, model: "evil-override", max_tokens: 8192 },
      fetch: sseFetch(bodies),
    }).streamChat(request()));
    // 自定义字段透传；核心字段 model 不被 extraBody 覆盖；extraBody 可提供 max_tokens
    expect(bodies[0]).toMatchObject({ model: "claude-opus-4-8", temperature: 0.7, max_tokens: 8192 });

    // 缺省不发送 max_tokens（不限制输出长度）
    const plain: Array<Record<string, unknown>> = [];
    await drain(new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: sseFetch(plain) }).streamChat(request()));
    expect(plain[0]).not.toHaveProperty("max_tokens");

    // 显式 maxTokens 仍生效
    const limited: Array<Record<string, unknown>> = [];
    await drain(new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", maxTokens: 4096, fetch: sseFetch(limited) }).streamChat(request()));
    expect(limited[0]).toMatchObject({ max_tokens: 4096 });
  });

  it("anthropic merges extraBody and lets extraBody.max_tokens override the default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const stream = (body: Record<string, unknown>) => {
      bodies.push(body);
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() { return { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
      };
    };
    const provider = new AnthropicProvider({ apiKey: "test", extraBody: { temperature: 0.3, max_tokens: 128_000 } });
    (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    await drain(provider.streamChat(request()));
    expect(bodies[0]).toMatchObject({ model: "claude-opus-4-8", temperature: 0.3, max_tokens: 128_000 });
  });
});
