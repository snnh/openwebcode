import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "gpt-5.4", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseFetch(bodies: Array<Record<string, unknown>>, payload: string, status = 200) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(payload, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as unknown as typeof globalThis.fetch;
}

function makeProvider(fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch, ...options });
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("OpenAIResponsesProvider streaming", () => {
  it("maps text deltas, usage (cached tokens) and done/end_turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "你好" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "世界" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
        },
      },
    ]);
    const events = await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request()));

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "text_delta", text: "世界" },
    ]);
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage", inputTokens: 70, outputTokens: 20, cacheRead: 30, cacheWrite: 0,
    });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(bodies[0]).toMatchObject({ model: "gpt-5.4", stream: true, instructions: "system", input: [] });
  });

  it("streams reasoning summary deltas as thinking_delta", async () => {
    const payload = sse([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "先想" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "再想" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "答" },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const bodies: Array<Record<string, unknown>> = [];
    const events = await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request({ effort: "high" })));

    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "先想" },
      { type: "thinking_delta", text: "再想" },
    ]);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: "high", summary: "auto" } });
  });

  it("gates reasoning summary and effort behind configuration flags", async () => {
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    const bodies: Array<Record<string, unknown>> = [];
    // provider 级关闭 summary 请求，请求级 reasoningContent: false 同样关闭
    await collect(makeProvider(sseFetch(bodies, payload), { reasoningContent: false }).streamChat(request({ effort: "low" })));
    await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request({ effort: "low", reasoningContent: false })));
    await collect(makeProvider(sseFetch(bodies, payload), { reasoningEffort: false }).streamChat(request({ effort: "low" })));

    expect(bodies[0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(bodies[0]?.reasoning).not.toHaveProperty("summary");
    expect(bodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(bodies[1]?.reasoning).not.toHaveProperty("summary");
    expect(bodies[2]).toMatchObject({ reasoning: { summary: "auto" } });
    expect(bodies[2]?.reasoning).not.toHaveProperty("effort");
  });

  it("aggregates function_call argument deltas into a single tool_call", async () => {
    const payload = sse([
      {
        type: "response.output_item.added", output_index: 0,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"cmd\":" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "\"ls\"}" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"cmd\":\"ls\"}" },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));

    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta: "" },
      { type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta: "{\"cmd\":" },
      { type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta: "\"ls\"}" },
    ]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("recovers function calls from response.completed output when deltas were not streamed", async () => {
    const payload = sse([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ id: "fc_9", type: "function_call", call_id: "call_9", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }],
        },
      },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_9", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("maps incomplete/max_output_tokens to max_tokens and refusal to refusal", async () => {
    const incomplete = sse([
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "半句" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      },
    ]);
    const events = await collect(makeProvider(sseFetch([], incomplete)).streamChat(request()));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });

    const refusal = sse([
      { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, delta: "不能" },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
    const refusalEvents = await collect(makeProvider(sseFetch([], refusal)).streamChat(request()));
    expect(refusalEvents.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });

  it("throws on HTTP errors, response.failed events and interrupted streams", async () => {
    const unauthorized = await collect(
      makeProvider(sseFetch([], "invalid key", 401)).streamChat(request()),
    ).catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(ProviderError);
    expect((unauthorized as ProviderError).kind).toBe("authentication");

    const failed = await collect(
      makeProvider(sseFetch([], sse([
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "x" },
        { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } },
      ]))).streamChat(request()),
    ).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).message).toContain("boom");

    let sentFirstChunk = false;
    const interruptedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 第一片正常送达后再出错（error 会清空未读队列，不能在 start 里同步 error）
        if (sentFirstChunk) return controller.error(new Error("socket hang up"));
        sentFirstChunk = true;
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n'));
      },
    });
    const interruptedFetch = (async () => new Response(interruptedBody, { status: 200 })) as unknown as typeof globalThis.fetch;
    const interrupted = await collect(makeProvider(interruptedFetch).streamChat(request())).catch((error: unknown) => error);
    expect(interrupted).toBeInstanceOf(ProviderError);
    expect((interrupted as ProviderError).kind).toBe("stream_interrupted");
  });

  it("rejects invalid cached token usage", async () => {
    const payload = sse([
      {
        type: "response.completed",
        response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 99 } } },
      },
    ]);
    await expect(collect(makeProvider(sseFetch([], payload)).streamChat(request()))).rejects.toThrow(/invalid cached token usage/);
  });
});

describe("OpenAIResponsesProvider request mapping", () => {
  it("maps messages to input items, joins instructions and flattens tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: "aGk=" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "历史思维不回传", provider: "gpt" },
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "ok", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(sseFetch(bodies, payload), { maxTokens: 4096 }).streamChat(request({
      systemSuffix: "动态尾部",
      messages,
      tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
    })));

    expect(bodies[0]?.instructions).toBe("system\n\n动态尾部");
    expect(bodies[0]?.max_output_tokens).toBe(4096);
    expect(bodies[0]?.tools).toEqual([{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }]);
    expect(bodies[0]?.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aGk=" },
          { type: "input_text", text: "看图" },
        ],
      },
      { role: "assistant", content: "我查一下" },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
    // thinking 块不回传（Responses 的 reasoning 回放依赖服务端 reasoning item 机制）
    expect(JSON.stringify(bodies[0]?.input)).not.toContain("历史思维不回传");
  });

  it("repairs dangling tool_call (no result persisted after abort) and drops orphan tool_result", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "tool_call", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }],
      },
      // 中断时结果未落盘：call_dangling 无对应 tool_result
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "call_orphan", content: "orphan", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request({ messages })));

    expect(bodies[0]?.input).toEqual([
      { role: "user", content: "继续" },
      { type: "function_call", call_id: "call_dangling", name: "bash", arguments: "{\"cmd\":\"sleep 600\"}" },
      { type: "function_call_output", call_id: "call_dangling", output: expect.stringContaining("interrupted") },
    ]);
  });

  it("merges extraBody under core fields and omits max_output_tokens by default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    await collect(makeProvider(sseFetch(bodies, payload), {
      extraBody: { temperature: 0.7, model: "evil-override", store: false },
    }).streamChat(request()));

    expect(bodies[0]).toMatchObject({ model: "gpt-5.4", temperature: 0.7, store: false });
    expect(bodies[0]).not.toHaveProperty("max_output_tokens");
    // 空 messages 且无 tools 时省略 tools 字段
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("serverWebSearch: tools 附加服务端 web_search（无 function tools 也发送），web_search_call 事件映射 server_tool", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([
      { type: "response.web_search_call.in_progress", item_id: "ws_1" },
      { type: "response.web_search_call.searching", item_id: "ws_1" },
      { type: "response.web_search_call.completed", item_id: "ws_1" },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "找到了" },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ id: "ws_1", type: "web_search_call" }], usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
    const events = await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request({ serverWebSearch: true })));

    expect(bodies[0]?.tools).toEqual([{ type: "web_search" }]);
    expect(events.filter((event) => event.type === "server_tool")).toEqual([
      { type: "server_tool", tool: "web_search", phase: "start" },
      { type: "server_tool", tool: "web_search", phase: "update" },
      { type: "server_tool", tool: "web_search", phase: "end" },
    ]);
    // web_search_call 输出项不产出 tool_call、不影响 stopReason
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("serverWebSearch 与 function tools 并存时 web_search 附加在末尾", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request({
      serverWebSearch: true,
      tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
    })));
    expect(bodies[0]?.tools).toEqual([
      { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
      { type: "web_search" },
    ]);
  });
});

describe("ProviderProfilesRuntime openai-responses branch", () => {
  it("instantiates OpenAIResponsesProvider for openai-responses profiles", async () => {
    const root = await tempRoot("owc-responses-profile-");
    const service = await ProviderProfilesService.load({ filePath: path.join(root, "provider-profiles.json") });
    const providers = new ProviderRegistry();
    const agent = {
      setSearchProvider() { /* noop */ },
      setWebFetchProvider() { /* noop */ },
    } as unknown as AgentRunner;
    const runtime = new ProviderProfilesRuntime(service, providers, agent, undefined, new EventBus());
    runtime.start();
    try {
      await service.upsertModel(undefined, {
        id: "GPT",
        enabled: true,
        interfaceType: "openai-responses",
        baseURL: "https://api.openai.test/v1",
        apiKey: "sk-test",
      });
      expect(providers.get("GPT")).toBeInstanceOf(OpenAIResponsesProvider);
    } finally {
      runtime.stop();
    }
  });
});
