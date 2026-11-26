import { describe, expect, it } from "vitest";
import { buildGeminiBody } from "../src/providers/gemini-request.js";
import { LLMApiProvider } from "../src/providers/llm-api-provider.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";
import type { ChatMessage } from "../src/sessions/types.js";

const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
const request = (overrides: Partial<StreamChatRequest> = {}): StreamChatRequest => ({
  model: "test-model",
  system: "system",
  messages: [],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
});
const sse = (events: unknown[]): Response => new Response(
  events.map((event) => typeof event === "string" ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);
const collect = async (provider: LLMApiProvider, req: StreamChatRequest): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamChat(req)) events.push(event);
  return events;
};
const message = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({
  id, role, createdAt: at(0), content: [{ type: "text", text }],
});

describe("LLMApiProvider transport", () => {
  it("chat-completions：请求体经内置构造器、SSE 工具/usage/终态归一，认证头由库注入", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let headers: Headers | undefined;
    let url = "";
    const provider = new LLMApiProvider({
      name: "compat",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-test",
      fetch: (async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse([
          { choices: [{ delta: { content: "你" } }] },
          { choices: [{ delta: { reasoning_content: "想" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] }, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } },
          "[DONE]",
        ].map((event) => typeof event === "string" ? event : event));
      }) as typeof fetch,
    });
    const events = await collect(provider, request({ messages: [message("u1", "user", "hi")], tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }] }));
    expect(url).toBe("https://example.invalid/v1/chat/completions");
    expect(headers?.get("authorization")).toBe("Bearer sk-test");
    expect(headers?.get("user-agent")).toMatch(/^owc\//);
    expect(bodies[0]).toMatchObject({ model: "test-model", stream: true, stream_options: { include_usage: true } });
    expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "你" }]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" } },
    ]);
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 7, outputTokens: 2, cacheRead: 3, cacheWrite: 0 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("anthropic：保留缓存断点/redacted thinking，事件映射为 OWC 语义", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let url = "";
    const provider = new LLMApiProvider({
      name: "claude",
      interfaceType: "anthropic-messages",
      baseURL: "https://example.invalid",
      apiKey: "sk-ant",
      promptCaching: true,
      fetch: (async (input, init) => {
        url = String(input);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse([
          { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "redacted" } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "text" } },
          { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "答" } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ]);
      }) as typeof fetch,
    });
    const events = await collect(provider, request({ messages: [message("u1", "user", "hi")], cacheBreakpoints: ["u1"] }));
    expect(url).toBe("https://example.invalid/v1/messages");
    expect(bodies[0]).toMatchObject({ model: "test-model", max_tokens: 64000, stream: true });
    expect((bodies[0]?.system as Array<Record<string, unknown>>)[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "想" }]);
    expect(events.filter((event) => event.type === "thinking_end")).toEqual([
      { type: "thinking_end", text: "想", signature: "sig" },
      { type: "thinking_end", text: "", redacted: "redacted" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("responses：full reasoning item、text item 签名、web_search 与 usage 拆分", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let url = "";
    const reasoning = { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "想" }] };
    const search = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["q"] } };
    const provider = new LLMApiProvider({
      name: "resp",
      interfaceType: "openai-responses",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-test",
      fetch: (async (input, init) => {
        url = String(input);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse([
          { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
          { type: "response.reasoning_text.delta", output_index: 0, delta: "想" },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          { type: "response.web_search_call.in_progress" },
          { type: "response.web_search_call.completed" },
          { type: "response.output_item.done", output_index: 1, item: search },
          { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", output_index: 2, item_id: "msg_1", delta: "答" },
          { type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_1", phase: "final_answer", content: [{ type: "output_text", text: "答" }] } },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 } } } },
        ]);
      }) as typeof fetch,
    });
    const events = await collect(provider, request({ model: "gpt-test", serverWebSearch: true }));
    expect(url).toBe("https://example.invalid/v1/responses");
    expect((bodies[0]?.tools as Array<Record<string, unknown>>).at(-1)).toEqual({ type: "web_search" });
    expect(events.find((event) => event.type === "thinking_end")).toMatchObject({ text: "想", signature: JSON.stringify(reasoning) });
    expect(events.filter((event) => event.type === "server_tool").map((event) => event.phase)).toEqual(["start", "end"]);
    expect(events.find((event) => event.type === "web_search_call")).toEqual({ type: "web_search_call", item: search });
    const textEnd = events.find((event) => event.type === "text_end") as { signature?: string };
    expect(JSON.parse(textEnd.signature ?? "{}")).toEqual({ v: 1, id: "msg_1", phase: "final_answer" });
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 6, outputTokens: 2, cacheRead: 3, cacheWrite: 1 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });


  it("gemini：native wire 路径/鉴权、thinking/text/tool 签名与 usage", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let url = "";
    let headers: Headers | undefined;
    const provider = new LLMApiProvider({
      name: "gemini",
      interfaceType: "gemini-generate-content",
      baseURL: "https://generativelanguage.googleapis.com",
      apiKey: "google-key",
      fetch: (async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse([{
          candidates: [{
            content: { parts: [
              { text: "想", thought: true, thoughtSignature: "sig-think" },
              { text: "答", thoughtSignature: "sig-text" },
              { functionCall: { id: "fc1", name: "bash", args: { cmd: "ls" } }, thoughtSignature: "sig-call" },
            ] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 1 },
        }]);
      }) as typeof fetch,
    });
    const events = await collect(provider, request({
      model: "gemini-3.8-flash",
      messages: [message("u1", "user", "hi")],
      tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
    }));
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect(headers?.get("x-goog-api-key")).toBe("google-key");
    expect(bodies[0]).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ functionDeclarations: [{ name: "bash", description: "run" }] }],
    });
    expect(events.filter((event) => event.type === "thinking_end")).toEqual([{ type: "thinking_end", text: "想", signature: "sig-think" }]);
    expect(events.filter((event) => event.type === "text_end")).toEqual([{ type: "text_end", text: "答", signature: "sig-text" }]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "fc1", name: "bash", input: { cmd: "ls" }, signature: "sig-call", providerId: "fc1" },
    ]);
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 9, outputTokens: 5, cacheRead: 1, cacheWrite: 0 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("gemini：历史 thinking/tool_call/functionResponse 原样回放，中断结果补占位", () => {
    const messages: ChatMessage[] = [
      message("u1", "user", "看看"),
      {
        id: "a1", role: "assistant", createdAt: at(1), content: [
          { type: "thinking", text: "想", signature: "sig-think", provider: "gemini" },
          { type: "text", text: "答", textSignature: "sig-text" },
          { type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" }, signature: "sig-call", providerId: "fc1" },
          { type: "tool_call", id: "call_2", name: "read_file", input: { path: "a" } },
        ],
      },
      {
        id: "t1", role: "tool", createdAt: at(2), content: [
          { type: "tool_result", toolCallId: "call_1", content: "{\"ok\":true}", isError: false },
        ],
      },
    ];
    const body = buildGeminiBody(request({
      model: "gemini-3.8-flash",
      system: "sys",
      messages,
      thinking: "enabled",
      effort: "high",
      maxTokens: 100,
      temperature: 0.2,
    }), { providerName: "gemini" });
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 100, temperature: 0.2, thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts).toEqual([
      { text: "想", thought: true, thoughtSignature: "sig-think" },
      { text: "答", thoughtSignature: "sig-text" },
      { functionCall: { id: "fc1", name: "bash", args: { cmd: "ls" } }, thoughtSignature: "sig-call" },
      { functionCall: { name: "read_file", args: { path: "a" } } },
    ]);
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "fc1", name: "bash", response: { ok: true } } },
        { functionResponse: { name: "read_file", response: { error: expect.stringContaining("interrupted") } } },
      ],
    });
  });

  it("HTTP 错误映射为 ProviderError 分类（401 不重试）", async () => {
    const provider = new LLMApiProvider({
      name: "bad",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      apiKey: "bad",
      fetch: (async () => new Response("invalid key", { status: 401 })) as typeof fetch,
    });
    await expect(collect(provider, request())).rejects.toMatchObject({ kind: "authentication", retryable: false });
  });

  it("SSE 截断：无 finish_reason/[DONE]/message_stop/response.completed 时以 done.stopReason=error 收尾", async () => {
    const sseResponse = (events: unknown[]) => sse(events);
    const chat = new LLMApiProvider({
      name: "chat-truncated",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      fetch: (async () => sseResponse([{ choices: [{ delta: { content: "半截" } }] }])) as typeof fetch,
    });
    expect((await collect(chat, request())).at(-1)).toEqual({ type: "done", stopReason: "error" });

    const anthropic = new LLMApiProvider({
      name: "claude-truncated",
      interfaceType: "anthropic-messages",
      baseURL: "https://example.invalid/v1",
      apiKey: "key",
      fetch: (async () => sseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半截" } },
      ])) as typeof fetch,
    });
    expect((await collect(anthropic, request({ model: "claude-test" }))).at(-1)).toEqual({ type: "done", stopReason: "error" });

    const responses = new LLMApiProvider({
      name: "resp-truncated",
      interfaceType: "openai-responses",
      baseURL: "https://example.invalid/v1",
      apiKey: "key",
      fetch: (async () => sseResponse([{ type: "response.output_text.delta", delta: "半截" }])) as typeof fetch,
    });
    expect((await collect(responses, request({ model: "gpt-test" }))).at(-1)).toEqual({ type: "done", stopReason: "error" });

    // 有 [DONE] 但端点不发 finish_reason：属于正常收尾
    const doneOnly = new LLMApiProvider({
      name: "chat-done",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      fetch: (async () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])) as typeof fetch,
    });
    expect((await collect(doneOnly, request())).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("streamIdleTimeoutMs=0 可关闭 idle 超时（设置页 0 语义）", () => {
    expect(() => new LLMApiProvider({
      name: "no-idle",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      streamIdleTimeoutMs: 0,
    })).not.toThrow();
  });

  it("429 映射为可重试 rate_limit，库内不叠加重试", async () => {
    let calls = 0;
    const provider = new LLMApiProvider({
      name: "rate-limited",
      interfaceType: "openai-chat-completions",
      baseURL: "https://example.invalid/v1",
      fetch: (async () => {
        calls += 1;
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      }) as typeof fetch,
    });
    await expect(collect(provider, request())).rejects.toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 2000 });
    expect(calls).toBe(1);
  });
});
