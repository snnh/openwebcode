import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ConcurrencyLimitedProvider, DEFAULT_MAX_CONCURRENT } from "../src/providers/concurrency-limiter.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider, MAX_SSE_EVENT_BYTES, readSseData } from "../src/providers/openai-compatible-provider.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";
import { tempRoot } from "./helpers/temp-roots.js";

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "gpt-5.4", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** 最小正常终态 payload（无输出项、无 usage）：只关心请求体的用例共用。 */
const COMPLETED = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);

function sseFetch(bodies: Array<Record<string, unknown>>, payload: string, status = 200) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(payload, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as unknown as typeof globalThis.fetch;
}

function makeProvider(fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch, ...options });
}

/** 响应正常完成的最小 payload：只关心请求体的用例共用。 */
const completedSseFetch = (bodies: Array<Record<string, unknown>>) => sseFetch(bodies, COMPLETED);

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

// ---- 跨 provider 场景组：request 变体与共用 fetch/collect 设施 ----
const reasoningRequest = (overrides: Partial<StreamChatRequest> = {}): StreamChatRequest =>
  request({ model: "claude-opus-4-8", ...overrides });

const idleRequest = (): StreamChatRequest => request({ model: "test-model" });
const errorRequest = idleRequest;

async function drain(iterable: AsyncIterable<unknown>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

function makeCompat(fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch, ...options });
}

/** 同源 thinking 回放场景的固定 provider 名（异源 thinking 块据此过滤）。 */
const zijianCompat = (fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAICompatibleProvider =>
  makeCompat(fetch, { name: "zijian", ...options });

const reasoningSseFetch = (bodies: Array<Record<string, unknown>>) => sseFetch(bodies, "data: [DONE]\n\n");

const textEncoder = new TextEncoder();
const chunk = (text: string): Uint8Array => textEncoder.encode(text);

// ---- provider-stream-idle 组 ----
function idleSseResponse(pump: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { pump(controller); } });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const idleDataEvent = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;

// ---- provider-error-handling 组 ----
function errorFetchWith(body: string, status = 200): typeof globalThis.fetch {
  const contentType = status === 200 ? "text/event-stream" : "application/json";
  return (async () => new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof globalThis.fetch;
}

async function expectProviderError(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderError> {
  let caught: unknown;
  try {
    await collect(iterable);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderError);
  return caught as ProviderError;
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
    const bodies: Array<Record<string, unknown>> = [];
    // provider 级关闭 summary 请求，请求级 reasoningContent: false 同样关闭
    await collect(makeProvider(completedSseFetch(bodies), { reasoningContent: false }).streamChat(request({ effort: "low" })));
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ effort: "low", reasoningContent: false })));
    await collect(makeProvider(completedSseFetch(bodies), { reasoningEffort: false }).streamChat(request({ effort: "low" })));

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
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: "aGk=" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "ok", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(completedSseFetch(bodies), { maxTokens: 4096 }).streamChat(request({
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
  });

  it("请求级 temperature/topP 透传为 temperature/top_p；携带 effort（推理档）时不下发", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ temperature: 0.7, topP: 0.9 })));
    expect(bodies[0]?.temperature).toBe(0.7);
    expect(bodies[0]?.top_p).toBe(0.9);

    // 推理档端点拒绝 sampling 参数：provider 不下发，避免 400
    const reasoningBodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(completedSseFetch(reasoningBodies)).streamChat(request({ temperature: 0.7, topP: 0.9, effort: "low" })));
    expect(reasoningBodies[0]?.temperature).toBeUndefined();
    expect(reasoningBodies[0]?.top_p).toBeUndefined();
  });

  it("思维链回传开启时同源 thinking 块以 reasoning item 明文回传（每个 function_call 前各一条），关闭或异源不回传", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "先分析", provider: "openai-responses" },
          { type: "thinking", text: "异源思维", provider: "other-provider" },
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a" } },
          { type: "tool_call", id: "call_2", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "A", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "call_2", content: "B", isError: false }], createdAt: "2026-01-01T00:00:03.000Z" },
    ];
    // 开启（缺省 reasoningContent=true）：DeepSeek 规则——每个 function_call 前各放一条完整
    // reasoning item（output 打断关联链，多调用轮只在开头放一条必 400）；异源过滤
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: "继续" },
      { role: "assistant", content: "我查一下" },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "先分析" }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "先分析" }] },
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
    ]);
    // 请求级关闭：不回传（与 openai-compatible 的 reasoningContent=false 同语义）
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages, reasoningContent: false })));
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: "继续" },
      { role: "assistant", content: "我查一下" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
    ]);
  });

  it("repairs dangling tool_call (no result persisted after abort) and drops orphan tool_result", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "tool_call", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }],
      },
      // 中断时结果未落盘：call_dangling 无对应 tool_result
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "call_orphan", content: "orphan", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));

    expect(bodies[0]?.input).toEqual([
      { role: "user", content: "继续" },
      { type: "function_call", call_id: "call_dangling", name: "bash", arguments: "{\"cmd\":\"sleep 600\"}" },
      { type: "function_call_output", call_id: "call_dangling", output: expect.stringContaining("interrupted") },
    ]);
  });

  it("思维链回传开启但 assistant 消息缺同源 thinking 素材：不回传 reasoning item 且诊断留痕", async () => {
    // 留痕输出经构造注入收集器（diagnosticWriter）：引用在创建 provider 时确定，
    // 不依赖任何模块级全局状态或 process.stderr 可替换性；限频键与 dangling 用例不同
    const lines: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    // 注意：限频键为 `消息id:tool_call id`，本文件首个映射用例已占用 "a1:call_1"，
    // 此处必须使用独立 id，否则同进程内键控限频会把本用例的留痕吞掉
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a_missing", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_missing", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_missing", content: "B", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    const provider = new OpenAIResponsesProvider({
      baseURL: "https://example.invalid/v1",
      fetch: completedSseFetch(bodies),
      diagnosticWriter: (line) => lines.push(line),
    });
    await collect(provider.streamChat(request({ messages })));
    // 无素材时 function_call 照常发出（不回传 reasoning item），留痕提示思维模式端点可能拒绝
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: "继续" },
      { role: "assistant", content: "我查一下" },
      { type: "function_call", call_id: "call_missing", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_missing", output: "B" },
    ]);
    expect(lines.some((line) => line.includes("缺少同源 thinking 素材"))).toBe(true);
  });

  it("merges extraBody under core fields and omits max_output_tokens by default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await collect(makeProvider(completedSseFetch(bodies), {
      extraBody: { temperature: 0.7, model: "evil-override", store: false },
    }).streamChat(request()));

    expect(bodies[0]).toMatchObject({ model: "gpt-5.4", temperature: 0.7, store: false });
    expect(bodies[0]).not.toHaveProperty("max_output_tokens");
    // 空 messages 且无 tools 时省略 tools 字段
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("serverWebSearch: tools 附加服务端 web_search（附加在 function tools 末尾），web_search_call 事件映射 server_tool", async () => {
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
    // 无 function tools 也发送 tools 字段
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

    // 与 function tools 并存时 web_search 附加在末尾
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({
      serverWebSearch: true,
      tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
    })));
    expect(bodies[1]?.tools).toEqual([
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
      // 生产注册路径按 DEFAULT_MAX_CONCURRENT（3）并发上限包装：get 返回限流包装器，
      // 底层为 OpenAIResponsesProvider（stats 证明包装生效）
      const registered = providers.get("GPT");
      expect(registered).toBeInstanceOf(ConcurrencyLimitedProvider);
      expect(registered?.name).toBe("GPT");
      expect(providers.concurrencyStats()["GPT"]).toEqual({ active: 0, queued: 0, maxConcurrent: DEFAULT_MAX_CONCURRENT });
    } finally {
      runtime.stop();
    }
  });
});

describe("provider reasoning parameters", () => {
  it("translates Anthropic thinking and effort without hard-coded defaults", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies);

    await drain(provider.streamChat(reasoningRequest({ thinking: "adaptive", effort: "xhigh" })));
    await drain(provider.streamChat(reasoningRequest({ thinking: "disabled" })));
    await drain(provider.streamChat(reasoningRequest({ thinking: "enabled" })));
    await drain(provider.streamChat(reasoningRequest({
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
    injectMockStream(limited, bodies);
    await drain(limited.streamChat(reasoningRequest({ thinking: "enabled" })));
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
    const fetch = reasoningSseFetch(bodies);
    await drain(makeCompat(fetch).streamChat(reasoningRequest({ effort: "high" })));
    await drain(makeCompat(fetch, { reasoningEffort: false }).streamChat(reasoningRequest({ effort: "high" })));
    expect(bodies[0]).toMatchObject({ reasoning_effort: "high" });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("omits an empty tools field instead of advertising an unavailable tool schema", async () => {
    const anthropicBodies: Array<Record<string, unknown>> = [];
    const anthropic = new AnthropicProvider({ apiKey: "test" });
    injectMockStream(anthropic, anthropicBodies);
    await drain(anthropic.streamChat(reasoningRequest()));

    const openAiBodies: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(openAiBodies)).streamChat(reasoningRequest()));

    expect(anthropicBodies[0]).not.toHaveProperty("tools");
    expect(openAiBodies[0]).not.toHaveProperty("tools");
  });

  it("replays same-provider thinking blocks as reasoning_content (思维链保留回传)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = reasoningSseFetch(bodies);
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

    // 默认开启：同源 thinking 回放 reasoning_content（含 tool_calls 消息），异源不回带
    await drain(zijianCompat(fetch).streamChat(reasoningRequest({ messages })));
    const assistant = (bodies[0]!.messages as Array<Record<string, unknown>>)[2]!;
    expect(assistant.reasoning_content).toBe("先想第一步\n再想想");
    expect(assistant.tool_calls).toHaveLength(1);

    // reasoningContent: false 关闭回传，消息形态与旧版一致
    await drain(zijianCompat(fetch, { reasoningContent: false }).streamChat(reasoningRequest({ messages })));
    const legacy = (bodies[1]!.messages as Array<Record<string, unknown>>)[2]!;
    expect(legacy).not.toHaveProperty("reasoning_content");

    // 无异名 thinking 块时消息形态不变（回归）
    await drain(zijianCompat(fetch).streamChat(reasoningRequest()));
    expect((bodies[2]!.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty("reasoning_content");
  });

  it("request-level reasoningContent overrides the provider-level default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = reasoningSseFetch(bodies);
    const messages: StreamChatRequest["messages"] = [
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "thinking", text: "想一下", provider: "zijian" }, { type: "text", text: "答" }],
      },
    ];

    // 请求级 false：即使 provider 默认开也不回带（gpt/claude 前缀模型走此路径）
    await drain(zijianCompat(fetch).streamChat(reasoningRequest({ messages, reasoningContent: false })));
    expect((bodies[0]!.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty("reasoning_content");

    // 请求级 true：盖过 provider 级 reasoningContent:false
    await drain(zijianCompat(fetch, { reasoningContent: false }).streamChat(reasoningRequest({ messages, reasoningContent: true })));
    expect((bodies[1]!.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ reasoning_content: "想一下" });
  });
});

describe("provider custom request body (extraBody)", () => {
  it("omits max_tokens by default and merges extraBody under core fields", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(bodies), {
      extraBody: { temperature: 0.7, model: "evil-override", max_tokens: 8192 },
    }).streamChat(reasoningRequest()));
    // 自定义字段透传；核心字段 model 不被 extraBody 覆盖；extraBody 可提供 max_tokens
    expect(bodies[0]).toMatchObject({ model: "claude-opus-4-8", temperature: 0.7, max_tokens: 8192 });

    // 缺省不发送 max_tokens（不限制输出长度）
    const plain: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(plain)).streamChat(reasoningRequest()));
    expect(plain[0]).not.toHaveProperty("max_tokens");

    // 显式 maxTokens 仍生效
    const limited: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(limited), { maxTokens: 4096 }).streamChat(reasoningRequest()));
    expect(limited[0]).toMatchObject({ max_tokens: 4096 });
  });

  it("请求级 temperature/topP 映射为 temperature/top_p（覆盖 extraBody 同名字段）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(bodies))
      .streamChat(reasoningRequest({ temperature: 0.7, topP: 0.9 })));
    expect(bodies[0]).toMatchObject({ temperature: 0.7, top_p: 0.9 });

    // 未下发时不发这两个字段，由端点默认决定
    const plain: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(plain)).streamChat(reasoningRequest()));
    expect(plain[0]).not.toHaveProperty("temperature");
    expect(plain[0]).not.toHaveProperty("top_p");
  });

  it("anthropic merges extraBody and lets extraBody.max_tokens override the default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({ apiKey: "test", extraBody: { temperature: 0.3, max_tokens: 128_000 } });
    injectMockStream(provider, bodies);
    await drain(provider.streamChat(reasoningRequest()));
    expect(bodies[0]).toMatchObject({ model: "claude-opus-4-8", temperature: 0.3, max_tokens: 128_000 });

    // 优先级：request.maxTokens > extraBody.max_tokens > provider 默认
    await drain(provider.streamChat(reasoningRequest({ maxTokens: 256 })));
    expect(bodies[1]).toMatchObject({ max_tokens: 256 });
  });
});

describe("provider tool_call_delta streaming", () => {
  it("openai emits argument fragments with the accumulated id and name", async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ba" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "sh", arguments: "{\"cmd\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"ls\"}" } }] }, finish_reason: null }] },
      { choices: [{ finish_reason: "tool_calls", delta: {} }] },
    ];
    const sse = chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
    const fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const events = await collect(makeCompat(fetch as typeof globalThis.fetch).streamChat(reasoningRequest()));

    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toEqual([
      { type: "tool_call_delta", id: "call_1", name: "ba", argumentsDelta: "" },
      { type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta: "{\"cmd\":" },
      { type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta: "\"ls\"}" },
    ]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_1", name: "bash", input: { cmd: "ls" } }]);
  });

  it("anthropic maps content_block_start and input_json_delta", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const stream = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先看" } };
        yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } };
        yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } };
        yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } };
      },
      async finalMessage() {
        return {
          content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "tool_use",
        };
      },
    });
    (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    const events = await collect(provider.streamChat(reasoningRequest()));

    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", id: "tu_1", name: "read_file", argumentsDelta: "" },
      { type: "tool_call_delta", id: "tu_1", argumentsDelta: "{\"path\":" },
      { type: "tool_call_delta", id: "tu_1", argumentsDelta: "\"a.ts\"}" },
    ]);
    expect(events.some((event) => event.type === "tool_call" && event.id === "tu_1")).toBe(true);
  });
});

describe("SSE stream idle timeout", () => {
  it("心跳注释续命但无 data 事件：判半开连接，抛 stream_interrupted（可重试）", async () => {
    const fetch = (async () => idleSseResponse((controller) => {
      controller.enqueue(chunk(idleDataEvent({ choices: [{ delta: { content: "hi" } }] })));
      const timer = setInterval(() => {
        try { controller.enqueue(chunk(": ping\n\n")); } catch { clearInterval(timer); }
      }, 20);
    })) as unknown as typeof globalThis.fetch;
    const provider = makeCompat(fetch, { streamIdleTimeoutMs: 100 });

    let caught: unknown;
    try {
      for await (const _ of provider.streamChat(idleRequest())) { /* drain */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("stream_interrupted");
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as Error).message).toMatch(/half-open/);
  });

  it("持续产出 data 事件会重置计时：慢速流不被误杀", async () => {
    const fetch = (async () => idleSseResponse((controller) => {
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        try {
          if (step <= 5) controller.enqueue(chunk(idleDataEvent({ choices: [{ delta: { content: `t${step}` } }] })));
          else if (step === 6) controller.enqueue(chunk(idleDataEvent({ choices: [{ delta: {}, finish_reason: "stop" }] })));
          else {
            controller.enqueue(chunk("data: [DONE]\n\n"));
            controller.close();
            clearInterval(timer);
          }
        } catch { clearInterval(timer); }
      }, 40);
    })) as unknown as typeof globalThis.fetch;
    // 间隔 40ms < idle 上限 200ms：流虽慢但持续有 data，不应触发超时
    const provider = makeCompat(fetch, { streamIdleTimeoutMs: 200 });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamChat(idleRequest())) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(5);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("streamIdleTimeoutMs=0 关闭超时：完全静默的流挂到调用方中止", async () => {
    const fetch = (async (_input: unknown, init?: RequestInit) => idleSseResponse((controller) => {
      controller.enqueue(chunk(idleDataEvent({ choices: [{ delta: { content: "hi" } }] })));
      // 真实 fetch 会把 signal 中止传导到响应体；假流这里手动复现
      init?.signal?.addEventListener("abort", () => {
        try { controller.error(new DOMException("The operation was aborted", "AbortError")); } catch { /* 已关闭 */ }
      });
    })) as unknown as typeof globalThis.fetch;
    const provider = makeCompat(fetch, { streamIdleTimeoutMs: 0 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(async () => {
      for await (const _ of provider.streamChat({ ...idleRequest(), signal: controller.signal })) { /* drain */ }
    }).rejects.toThrow();
  });
});

describe("provider 错误体截断", () => {
  it("openai-compatible：超限错误体截断为 2000 字符 + …", async () => {
    const detail = `{"error":"${"x".repeat(5000)}"}`;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(detail, 500) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(2_100);
    expect(error.message).not.toContain(detail.slice(-20));
  });

  it("openai-responses：超限错误体同样截断，两家口径一致", async () => {
    const detail = `{"error":"${"y".repeat(5000)}"}`;
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(detail, 400) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(2_100);
  });

  it("未超限的错误体原样保留", async () => {
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith("short detail", 500) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.message).toContain("short detail");
    expect(error.message).not.toContain("…");
  });
});

describe("readSseData 边界", () => {
  it("单事件超过字节上限：判确定性协议错误（不可重试）", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 持续喂字节却永不发送事件边界（空行）
        controller.enqueue(chunk(`data: ${"x".repeat(MAX_SSE_EVENT_BYTES)}`));
      },
    });
    const error = await expectProviderError(readSseData(stream, { idleTimeoutMs: 0 }) as AsyncIterable<ProviderEvent>);
    expect(error.kind).toBe("stream_interrupted");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/exceeded/);
  });

  it("流尾残留 buffer 无空行终止：仍按最后一个事件解析", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk("data: first\n\ndata: tail-without-terminator"));
        controller.close();
      },
    });
    const events: string[] = [];
    for await (const data of readSseData(stream, { idleTimeoutMs: 0 })) events.push(data);
    expect(events).toEqual(["first", "tail-without-terminator"]);
  });

  it("provider 级回归：收尾 chunk 无空行终止的成功响应不再判失败", async () => {
    // 唯一的 data 事件无 \n\n 结尾（端点提前关连接）：旧实现会静默丢弃 → stopReason 误判 error
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}`;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(body) });
    const events = await collect(provider.streamChat(errorRequest()));
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});

describe("工具参数 JSON 解析失败归不可重试", () => {
  it("openai-compatible：流被 max_tokens 截断的参数 JSON → invalid_request（不可重试）", async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{\"cmd\":" } }] } }] },
      { choices: [{ finish_reason: "length", delta: {} }] },
    ];
    const body = chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(body) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
  });

  it("openai-responses：function_call 参数截断 → invalid_request（不可重试）", async () => {
    const body = [
      { type: "response.output_item.done", item_id: "fc_1", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":" } },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(body) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
  });
});

describe("Responses response.failed/error 按 failure code 区分可重试", () => {
  const failedBody = (event: Record<string, unknown>): string => `data: ${JSON.stringify(event)}\n\n`;

  it.each([
    { event: { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } }, kind: "overloaded", retryable: true },
    { event: { type: "error", code: "rate_limit", message: "slow down" }, kind: "rate_limit", retryable: true },
    { event: { type: "response.failed", response: { status: "failed", error: { code: "invalid_request", message: "bad" } } }, kind: "unknown", retryable: false },
    { event: { type: "response.failed", response: { status: "failed", error: { message: "bad" } } }, kind: "unknown", retryable: false },
  ])("$kind / retryable=$retryable", async ({ event, kind, retryable }) => {
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(failedBody(event)) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });
});
describe("OpenAICompatibleProvider 工具配对修复", () => {
  it("悬空 tool_call（中断未落盘结果）补占位 tool 消息，游离 tool_result 丢弃", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = makeCompat(reasoningSseFetch(bodies));
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "tool_call", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }],
      },
      // !shell 直写的 tool_result：无对应 assistant tool_call（shell-* id），原样发送会 400 tool_call_id is not found
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "shell-abc12345", content: "orphan", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await drain(provider.streamChat(reasoningRequest({ messages })));

    expect(bodies[0]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_dangling", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"sleep 600\"}" } }],
      },
      { role: "tool", tool_call_id: "call_dangling", content: expect.stringContaining("interrupted") },
    ]);
  });

  it("tool_result 内联到对应 assistant tool_calls 之后，重复 call id 只发一次", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = makeCompat(reasoningSseFetch(bodies));
    const toolCall = { type: "tool_call" as const, id: "call_1", name: "read_file", input: { path: "a" } };
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "查" }], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "我查一下" }, toolCall], createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "A", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
      // 压缩/分支残留：同一 call id 在另一条 assistant 消息重复出现
      { id: "a2", role: "assistant", content: [toolCall], createdAt: "2026-01-01T00:00:03.000Z" },
    ];
    await drain(provider.streamChat(reasoningRequest({ messages })));

    expect(bodies[0]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "我查一下",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "assistant", content: null },
    ]);
  });
});
