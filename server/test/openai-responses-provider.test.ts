import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ConcurrencyLimitedProvider, DEFAULT_MAX_CONCURRENT } from "../src/providers/concurrency-limiter.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider, MAX_SSE_EVENT_BYTES, readSseData } from "../src/providers/openai-compatible-provider.js";
import { OpenAIResponsesProvider, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, PLACEHOLDER_REASONING_TEXT } from "../src/providers/openai-responses-provider.js";
import { deriveMessageItemId } from "../src/providers/responses-replay.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import type { TextContent } from "../src/sessions/types.js";
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

  it("captures reasoning item id/structure and function_call item id for replay (thinking_end signature / tool_call itemId)", async () => {
    const reasoningItem = {
      type: "reasoning",
      id: "rs_ab12",
      status: "completed",
      content: [{ type: "reasoning_text", text: "先分析再行动", annotations: [] }],
    };
    const payload = sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_ab12" } },
      { type: "response.reasoning_text.delta", item_id: "rs_ab12", output_index: 0, delta: "先分析" },
      { type: "response.reasoning_text.delta", item_id: "rs_ab12", output_index: 0, delta: "再行动" },
      {
        type: "response.output_item.added", output_index: 1,
        item: { id: "fc_111", type: "function_call", call_id: "call_1", name: "bash" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_111", output_index: 1, delta: "{\"cmd\":\"ls\"}" },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      {
        type: "response.output_item.done", output_index: 1,
        item: { id: "fc_111", type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}", status: "completed" },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [reasoningItem, { id: "fc_111", type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}" }],
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
        },
      },
    ]);
    const bodies: Array<Record<string, unknown>> = [];
    const events = await collect(makeProvider(sseFetch(bodies, payload)).streamChat(request()));

    // reasoning 收尾：thinking_end 携带完整累积文本与完整原始 item（signature，含 rs_ id）
    const thinkingEnds = events.filter((event) => event.type === "thinking_end") as Array<{ text: string; signature?: string }>;
    expect(thinkingEnds).toHaveLength(1);
    expect(thinkingEnds[0]?.text).toBe("先分析再行动");
    expect(JSON.parse(thinkingEnds[0]?.signature ?? "{}")).toEqual(reasoningItem);
    // function_call：tool_call 事件透传原始 fc item id（回放时原样回传）
    const toolCalls = events.filter((event) => event.type === "tool_call") as Array<{ type: string; id: string; itemId?: string; name: string }>;
    expect(toolCalls).toEqual([{ type: "tool_call", id: "call_1", itemId: "fc_111", name: "bash", input: { cmd: "ls" } }]);
  });

  it("gates reasoning summary and effort behind configuration flags", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    // provider 级关闭 summary 请求
    await collect(makeProvider(completedSseFetch(bodies), { reasoningContent: false }).streamChat(request({ effort: "low" })));
    await collect(makeProvider(completedSseFetch(bodies), { reasoningEffort: false }).streamChat(request({ effort: "low" })));

    expect(bodies[0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(bodies[0]?.reasoning).not.toHaveProperty("summary");
    expect(bodies[1]).toMatchObject({ reasoning: { summary: "auto" } });
    expect(bodies[1]?.reasoning).not.toHaveProperty("effort");
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
      { type: "tool_call", id: "call_1", itemId: "fc_1", name: "bash", input: { cmd: "ls" } },
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
      { type: "tool_call", id: "call_9", itemId: "fc_9", name: "read_file", input: { path: "a.ts" } },
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

  it("usage: cache_write 上报，cached+cacheWrite 超过 input 时钳到 0（不抛错）", async () => {
    const payload = sse([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 6, cache_write_tokens: 8 },
          },
        },
      },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage", inputTokens: 0, outputTokens: 5, cacheRead: 6, cacheWrite: 8,
    });

    // 负数/非整数 cache_write 仍是确定性错误（沿用 cached_tokens 的校验口径）
    const badWrite = sse([
      {
        type: "response.completed",
        response: {
          status: "completed", output: [],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cache_write_tokens: -1 } },
        },
      },
    ]);
    await expect(collect(makeProvider(sseFetch([], badWrite)).streamChat(request()))).rejects.toThrow(/invalid cache write token usage/);
  });

  it("refusal.delta 既置 sawRefusal 又按 message 文本槽发 text_delta", async () => {
    const payload = sse([
      { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, delta: "不能" },
      { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, delta: "说" },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "不能" },
      { type: "text_delta", text: "说" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });

  it("reasoning_summary_part.done 追加 \"\\n\\n\" 为 thinking_delta，content parts 以 \\n\\n 拼接为权威文本", async () => {
    const payload = sse([
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "想" },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "再想" },
      {
        type: "response.output_item.done", output_index: 0,
        item: { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "想" }, { type: "reasoning_text", text: "再想" }] },
      },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "想" },
      { type: "thinking_delta", text: "\n\n" },
      { type: "thinking_delta", text: "再想" },
    ]);
    const thinkingEnd = events.find((event) => event.type === "thinking_end") as { text: string; signature?: string } | undefined;
    expect(thinkingEnd?.text).toBe("想\n\n再想");
  });

  it("message output_item.done 以权威文本兜底并发出 text_end（v1 textSignature）", async () => {
    const payload = sse([
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "你好" },
      // 端点把剩余文本仅在 output_item.done 给出（未逐片流式）
      {
        type: "response.output_item.done", output_index: 0,
        item: { id: "msg_1", phase: "final_answer", type: "message", status: "completed", content: [{ type: "output_text", text: "你好世界", annotations: [] }] },
      },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    // 权威文本比累积更长且前缀一致 → 只补发后缀 delta
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "text_delta", text: "世界" },
    ]);
    const textEnd = events.find((event) => event.type === "text_end") as { text: string; signature?: string } | undefined;
    expect(textEnd).toEqual({ type: "text_end", text: "你好世界", signature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) });
  });

  it("B7：accumulated 超出权威（端点重复下发 delta）时不重发完整文本，text_end 以权威为准", async () => {
    const payload = sse([
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "你好世界" },
      // 端点重复下发同一段 delta（累积出现重复）
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "你好世界" },
      {
        type: "response.output_item.done", output_index: 0,
        item: { id: "msg_1", phase: "final_answer", type: "message", status: "completed", content: [{ type: "output_text", text: "你好世界", annotations: [] }] },
      },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    // 重复 delta 不再被完整重发（旧行为会多出一次完整 "你好世界"）
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "你好世界" },
      { type: "text_delta", text: "你好世界" },
    ]);
    const textEnd = events.find((event) => event.type === "text_end") as { text: string; signature?: string } | undefined;
    expect(textEnd).toEqual({ type: "text_end", text: "你好世界", signature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) });
  });

  it("B3：completed output 携带 encrypted_content 而持久化签名缺失时补发第二次 thinking_end（合并密文）", async () => {
    const reasoningItem = { type: "reasoning", id: "rs_b3", status: "completed", content: [{ type: "reasoning_text", text: "思考", annotations: [] }] };
    const encryptedReasoningItem = { ...reasoningItem, encrypted_content: "base64-encrypted" };
    const payload = sse([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_b3" } },
      { type: "response.reasoning_text.delta", item_id: "rs_b3", output_index: 0, delta: "思考" },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      {
        type: "response.completed",
        response: { status: "completed", output: [encryptedReasoningItem], usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
    const events = await collect(makeProvider(sseFetch([], payload)).streamChat(request()));
    const thinkingEnds = events.filter((event) => event.type === "thinking_end") as Array<{ text: string; signature?: string }>;
    expect(thinkingEnds).toHaveLength(2);
    expect(thinkingEnds[0]?.text).toBe("思考");
    expect(JSON.parse(thinkingEnds[0]?.signature ?? "{}")).toEqual(reasoningItem);
    // 第二次：encrypted_content 合并进持久化签名（B3 回填，store:false 多轮回放依赖）
    expect(thinkingEnds[1]?.text).toBe("思考");
    expect(JSON.parse(thinkingEnds[1]?.signature ?? "{}")).toEqual(encryptedReasoningItem);
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
          // dsh 口径：用户内容恒为 parts 数组且按原始块序（text 在前，image 在后）
          { type: "input_text", text: "看图" },
          { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGk=" },
        ],
      },
      // 规范序：缺同源 thinking 素材的轮不回传 reasoning（真机验证无需占位）
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
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

  it("思维链回传开启时按规范序回放：reasoning 置于 message item 之前（合并同源 thinking），多 tool_call 轮不重复；关闭或异源不回传", async () => {
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
    // 开启（缺省 reasoningContent=true）：DeepSeek 规范序——reasoning 合并后置于 message item
    // 之前（"merged into the adjacent assistant message"），多 tool_call 轮不重复（真机验证）；
    // 异源 thinking 过滤；reasoning/function_call 均不带 item id；message item id 缺省派生；
    // 并行 function_call 全前置（fc…fc → fco…fco，DeepSeek 归并校验要求，真机验证）
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "先分析" }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
    ]);
    // 请求级关闭：不回传（与 openai-compatible 的 reasoningContent=false 同语义）
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages, reasoningContent: false })));
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call", call_id: "call_2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
    ]);
  });

  it("思维链回传开启时持久化 signature 只取 reasoning_text 内容，itemId 不派发（DeepSeek Harness 同口径）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          {
            type: "thinking", text: "先分析", provider: "openai-responses",
            // 流式端 output_item.done 持久化的完整 reasoning item（含 rs_ id / annotations）
            signature: JSON.stringify({
              type: "reasoning",
              id: "rs_abc123",
              status: "completed",
              content: [{ type: "reasoning_text", text: "先分析", annotations: [] }],
            }),
          },
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", itemId: "fc_xyz789", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "A", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));
    // signature 提供权威 reasoning_text，但回放时剥掉 id/status/annotations（DeepSeek 输入只
    // 支持 plain-text content）；规范序 reasoning 在 message item 之前；function_call 只带 call_id，
    // 不派发持久化的 itemId
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "先分析" }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
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

    // 缺同源 thinking 素材的轮不回传 reasoning（真机验证规范序下无占位即通过）；悬空调用补 interrupted 占位输出
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      { type: "function_call", call_id: "call_dangling", name: "bash", arguments: "{\"cmd\":\"sleep 600\"}" },
      { type: "function_call_output", call_id: "call_dangling", output: expect.stringContaining("interrupted") },
    ]);
  });

  it("输入最后一条为 assistant 消息且缺同源 thinking 素材：补尾部占位 reasoning item 且诊断留痕（DeepSeek 尾部校验）", async () => {
    // 留痕输出经构造注入收集器（diagnosticWriter）：引用在创建 provider 时确定，
    // 不依赖任何模块级全局状态或 process.stderr 可替换性；限频键与 dangling 用例不同
    const lines: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a_tail", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_tail", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_tail", content: "B", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    // 控制：最后一条是 tool 消息（t1）时，缺素材轮不回传 reasoning
    const provider = new OpenAIResponsesProvider({
      baseURL: "https://example.invalid/v1",
      fetch: completedSseFetch(bodies),
      diagnosticWriter: (line) => lines.push(line),
    });
    await collect(provider.streamChat(request({ messages })));
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a_tail:0"),
      },
      { type: "function_call", call_id: "call_tail", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_tail", output: "B" },
    ]);
    expect(lines).toEqual([]);

    // 触发：最后一条是 assistant 且无 thinking 素材 → 补占位 reasoning（置于 message item 前）
    const tailMessages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a_tail2", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "text", text: "结论：完成" }],
      },
    ];
    await collect(provider.streamChat(request({ messages: tailMessages })));
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: PLACEHOLDER_REASONING_TEXT }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "结论：完成", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a_tail2:0"),
      },
    ]);
    expect(lines.some((line) => line.includes("缺同源 thinking 素材"))).toBe(true);
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
        type: "response.output_item.done",
        item_id: "ws_1",
        output_index: 1,
        item: { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", queries: ["北京天气"] } },
      },
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
    // 完整 web_search_call item 落盘事件（output_item.done 权威值，completed 兜底去重）
    expect(events.filter((event) => event.type === "web_search_call")).toEqual([
      {
        type: "web_search_call",
        item: { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", queries: ["北京天气"] } },
      },
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

  it("web_search_call 块回放：非加密与加密路径均原样回传（Pass back as-is，服务端恢复搜索结果）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const wsItem = { type: "web_search_call", id: "call_00_ws1", status: "completed", action: { type: "search", queries: ["北京天气"] } };
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "今天北京天气如何" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "先搜索", provider: "openai-responses" },
          // 交错：web_search_call 块按流式到达顺序夹在 thinking 之后、text 之前
          { type: "web_search_call", signature: JSON.stringify(wsItem), id: wsItem.id, status: wsItem.status },
          { type: "text", text: "今天北京多云转阴。" },
        ],
      },
    ];
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "今天北京天气如何" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "先搜索" }] },
      wsItem,
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "今天北京多云转阴。", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
    ]);
    // 加密路径同样原样回传
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages, responsesEncryptedReplay: true })));
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "今天北京天气如何" }] },
      wsItem,
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "今天北京多云转阴。", annotations: [] }],
        status: "completed", id: deriveMessageItemId("a1:0"),
      },
    ]);
    // 非法签名跳过（后随 user 消息，非尾部，不触发占位）
    const badMessages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "web_search_call", signature: "not-json", id: "x" }],
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "再问" }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages: badMessages })));
    expect(bodies[2]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "user", content: [{ type: "input_text", text: "再问" }] },
    ]);
  });

  it("thinking=disabled 且声明为 thinking 型：reasoning.effort 映射为 none（官方文档：none 禁用思考模式）；effort_only/未声明不下发", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ model: "deepseek-v4-pro", thinking: "disabled", thinkingStyle: "thinking" })));
    expect(bodies[0]?.reasoning).toMatchObject({ effort: "none" });
    // 用户显式 effort 优先于 thinking 默认（disabled 仍显式关闭）
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ model: "deepseek-v4-pro", thinking: "disabled", effort: "max", thinkingStyle: "thinking" })));
    expect(bodies[1]?.reasoning).toMatchObject({ effort: "none" });
    // effort_only 型（官方 OpenAI gpt 系）不下发 effort:none（官方无该取值）；summary 仍在
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ model: "gpt-5", thinking: "disabled", thinkingStyle: "effort_only" })));
    expect(bodies[2]?.reasoning).toEqual({ summary: "auto" });
    // 未声明 thinkingStyle 也不下发（只发 effort/summary）
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ model: "deepseek-v4-pro", thinking: "disabled" })));
    expect(bodies[3]?.reasoning).toEqual({ summary: "auto" });
    // enabled/adaptive 不覆盖
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ model: "deepseek-v4-pro", thinking: "enabled", effort: "high", thinkingStyle: "thinking" })));
    expect(bodies[4]?.reasoning).toMatchObject({ effort: "high" });
  });

  it("store:false 缺省随请求下发（dsh 无状态口径），options.store 可覆盖", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request()));
    expect(bodies[0]?.store).toBe(false);
    await drain(makeProvider(completedSseFetch(bodies), { store: true }).streamChat(request()));
    expect(bodies[1]?.store).toBe(true);
  });

  it("max_output_tokens 低于 16 时钳到 16（dsh OPENAI_RESPONSES_MIN_OUTPUT_TOKENS）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(completedSseFetch(bodies), { maxTokens: 8 }).streamChat(request()));
    expect(bodies[0]?.max_output_tokens).toBe(OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    await drain(makeProvider(completedSseFetch(bodies), { maxTokens: 4096 }).streamChat(request()));
    expect(bodies[1]?.max_output_tokens).toBe(4096);
  });

  it("include:[\"reasoning.encrypted_content\"] 仅当 responsesEncryptedReplay 且 (reasoningContent||effort)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    // 非加密：即使 effort 也不带 include
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ effort: "high" })));
    expect(bodies[0]).not.toHaveProperty("include");
    // 加密 + effort：带 include
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ responsesEncryptedReplay: true, effort: "high" })));
    expect(bodies[1]?.include).toEqual(["reasoning.encrypted_content"]);
    // 加密 + reasoningContent 开启（request 级）：带 include
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ responsesEncryptedReplay: true, reasoningContent: true })));
    expect(bodies[2]?.include).toEqual(["reasoning.encrypted_content"]);
    // 加密但 reasoningContent 关闭且无 effort：不带 include
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ responsesEncryptedReplay: true, reasoningContent: false })));
    expect(bodies[3]).not.toHaveProperty("include");
  });

  it("user 消息恒为 parts 数组（input_text/input_image，原始块序，image 带 detail:auto）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const messages: StreamChatRequest["messages"] = [
      {
        id: "u1", role: "user",
        content: [
          { type: "text", text: "先" },
          { type: "image", mediaType: "image/jpeg", data: "eA==" },
          { type: "text", text: "后" },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    await drain(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages })));
    expect(bodies[0]?.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "先" },
          { type: "input_image", detail: "auto", image_url: "data:image/jpeg;base64,eA==" },
          { type: "input_text", text: "后" },
        ],
      },
    ]);
  });

  it("加密回放模式：reasoning 原样回放（rs id）、message item id/phase 取自 textSignature、function_call 保留 fc id、无占位；非加密口径不变", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const reasoningItem = {
      type: "reasoning",
      id: "rs_enc1",
      status: "completed",
      content: [{ type: "reasoning_text", text: "加密思维", annotations: [] }],
    };
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "thinking", text: "加密思维", provider: "openai-responses", signature: JSON.stringify(reasoningItem) },
          // 无签名的同源 thinking：加密模式跳过（不补占位）
          { type: "thinking", text: "无签名思维", provider: "openai-responses" },
          { type: "text", text: "我查一下", textSignature: JSON.stringify({ v: 1, id: "msg_enc1", phase: "commentary" }) } as TextContent,
          // 无 textSignature 的文本块：派生兜底 id（msg_ + sha1("a1:1")）
          { type: "text", text: "再补充" } as TextContent,
          { type: "tool_call", id: "call_1", itemId: "fc_enc1", name: "bash", input: { cmd: "ls" } },
          // 非 fc_ 开头的 itemId（旧协议遗留 ctc_* 等）：加密回放不派发 id（避免配对校验）
          { type: "tool_call", id: "call_2", itemId: "ctc_2", name: "read_file", input: { path: "a" } },
        ],
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "A", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "call_2", content: "B", isError: false }], createdAt: "2026-01-01T00:00:03.000Z" },
    ];
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages, responsesEncryptedReplay: true })));
    expect(bodies[0]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      // 带签名的同源 thinking：完整 reasoning item 原样回放（含 rs id / annotations）
      reasoningItem,
      // 无签名 thinking：skip
      // 文本块：完整 message item，id/phase 取自 textSignature
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "我查一下", annotations: [] }],
        status: "completed",
        id: "msg_enc1",
        phase: "commentary",
      },
      // 无 textSignature 的文本块：派生稳定 msg_ id
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "再补充", annotations: [] }],
        status: "completed",
        id: deriveMessageItemId("a1:1"),
      },
      // function_call 保留 fc_ item id，随后内联 output
      { type: "function_call", call_id: "call_1", id: "fc_enc1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      // 非 fc_ itemId 不派发 id（仍内联 output）
      { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
    ]);
    // 同一消息关闭加密回放：DeepSeek 口径（纯文本剥离 + 规范序：逐 thinking 块一条 reasoning
    // 置于 message item 之前；文本合并为一条 message item；不派发 item id；并行 function_call
    // 全前置 fc…fc → fco…fco——逐对排列会被 DeepSeek 归并逻辑拆成多条虚拟 assistant 轮，
    // 第二条起无 reasoning 归属而 400（真机验证））
    await collect(makeProvider(completedSseFetch(bodies)).streamChat(request({ messages, responsesEncryptedReplay: false })));
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "继续" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "加密思维" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "无签名思维" }] },
      {
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "我查一下再补充", annotations: [] }],
        status: "completed", id: "msg_enc1", phase: "commentary",
      },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call_output", call_id: "call_2", output: "B" },
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
    // 未声明 thinkingStyle：按模型名推断（claude-opus-4-8 为 4.6+ → adaptive；预算已在该代弃用）
    expect(bodies[2]).toMatchObject({ thinking: { type: "adaptive" } });
    // cache 用例：消息级断点（体 3）
    expect(bodies[3]).toMatchObject({
      messages: [
        { content: [{ text: "cached", cache_control: { type: "ephemeral" } }] },
        { content: [{ text: "tail" }] },
      ],
    });
    // 声明 extended（claude 4.5 及以前形态）：enabled + budget（budget = maxTokens 减 1/8 正文余量，至少留 1024）
    await drain(provider.streamChat(reasoningRequest({ thinking: "enabled", thinkingStyle: "extended" })));
    expect(bodies[4]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 56_000 } });
    await drain(provider.streamChat(reasoningRequest({ model: "claude-opus-4-5", thinking: "enabled" })));
    expect(bodies[5]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 56_000 } });
    const limited = new AnthropicProvider({ apiKey: "test", maxTokens: 8000 });
    injectMockStream(limited, bodies);
    await drain(limited.streamChat(reasoningRequest({ thinking: "enabled", thinkingStyle: "extended" })));
    // 8000/8 = 1000 < 1024 下限，正文余量按 1024 计
    expect(bodies[6]).toMatchObject({ max_tokens: 8000, thinking: { type: "enabled", budget_tokens: 6976 } });
    // 国产/未知模型 anthropic 路径默认 adaptive（预算废弃时代）
    await drain(provider.streamChat(reasoningRequest({ model: "deepseek-v4-pro", thinking: "enabled" })));
    expect(bodies[7]).toMatchObject({ thinking: { type: "adaptive" } });
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
  it("compat：显式 maxTokens 仍映射为 max_tokens（缺省省略由跨 provider 组覆盖）", async () => {
    const limited: Array<Record<string, unknown>> = [];
    await drain(makeCompat(reasoningSseFetch(limited), { maxTokens: 4096 }).streamChat(reasoningRequest()));
    expect(limited[0]).toMatchObject({ max_tokens: 4096 });
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
    { event: { type: "error", code: "rate_limit_exceeded", message: "slow down" }, kind: "rate_limit", retryable: true },
    { event: { type: "response.failed", response: { status: "failed", error: { code: "overloaded", message: "busy" } } }, kind: "overloaded", retryable: true },
    { event: { type: "response.failed", response: { status: "failed", error: { code: "invalid_request", message: "bad" } } }, kind: "unknown", retryable: false },
  ])("$kind / retryable=$retryable", async ({ event, kind, retryable }) => {
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: errorFetchWith(failedBody(event)) });
    const error = await expectProviderError(provider.streamChat(errorRequest()));
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });
});
describe("OpenAICompatibleProvider 工具配对修复", () => {

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
