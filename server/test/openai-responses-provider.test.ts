import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesRuntime } from "../src/provider-profiles-runtime.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { ConcurrencyLimitedProvider, DEFAULT_MAX_CONCURRENT } from "../src/providers/concurrency-limiter.js";
import { MAX_SSE_EVENT_BYTES, OpenAICompatibleProvider, readSseData } from "../src/providers/openai-compatible-provider.js";
import { OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, OpenAIResponsesProvider, PLACEHOLDER_REASONING_TEXT } from "../src/providers/openai-responses-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { deriveMessageItemId } from "../src/providers/responses-replay.js";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import type { MessageContent, TextContent, ThinkingContent, ToolCallContent } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";
import { tempRoot } from "./helpers/temp-roots.js";
// ---- 公共设施与工厂 ----
const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`; const encoder = new TextEncoder();
const request = (overrides: Partial<StreamChatRequest> = {}): StreamChatRequest => ({ model: "gpt-5.4", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides });
const reasoningRequest = (overrides: Partial<StreamChatRequest> = {}): StreamChatRequest => request({ model: "claude-opus-4-8", ...overrides });
const idleRequest = (): StreamChatRequest => request({ model: "test-model" }); const errorRequest = idleRequest;
const sse = (events: Array<Record<string, unknown>>): string => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""); const eventBody = (event: Record<string, unknown>): string => `data: ${JSON.stringify(event)}\n\n`;
const contentType = (status: number) => ({ "content-type": status === 200 ? "text/event-stream" : "application/json" });
/** 捕获请求体的 SSE fetch；非 200 时按 JSON 错误体返回。 */
const sseFetch = (bodies: Array<Record<string, unknown>>, payload: string, status = 200): typeof globalThis.fetch => (async (_input: string | URL | Request, init?: RequestInit) => {
  bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return new Response(payload, { status, headers: contentType(status) });
}) as unknown as typeof globalThis.fetch;
/** 不捕获请求体的响应 fetch（错误/终态路径共用）。 */
const rawFetch = (body: string, status = 200): typeof globalThis.fetch => (async () => new Response(body, { status, headers: contentType(status) })) as unknown as typeof globalThis.fetch;
const makeProvider = (fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAIResponsesProvider => new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch, ...options });
const makeCompat = (fetch: typeof globalThis.fetch, options: Record<string, unknown> = {}): OpenAICompatibleProvider => new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch, ...options });
/** 最小正常终态 payload：只关心请求体的用例共用。 */
const COMPLETED = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
const collect = async <T,>(iterable: AsyncIterable<T>): Promise<T[]> => { const events: T[] = []; for await (const event of iterable) events.push(event); return events; };
const drain = async (iterable: AsyncIterable<unknown>): Promise<void> => { for await (const _ of iterable) { /* drain */ } };
const expectProviderError = async (iterable: AsyncIterable<ProviderEvent>): Promise<ProviderError> => {
  const caught = await collect(iterable).then(() => undefined, (error: unknown) => error); expect(caught).toBeInstanceOf(ProviderError);
  return caught as ProviderError;
};
// 会话消息 / input item 工厂：压缩长 fixture
type Msg = StreamChatRequest["messages"][number];
const userMsg = (text: string, second = 0, id = "u1"): Msg => ({ id, role: "user", content: [{ type: "text", text }], createdAt: at(second) }); const assistantMsg = (content: MessageContent[], second = 1, id = "a1"): Msg => ({ id, role: "assistant", content, createdAt: at(second) });
const toolMsg = (results: Array<[string, string, boolean?]>, second = 2, id = "t1"): Msg => ({ id, role: "tool", createdAt: at(second), content: results.map(([toolCallId, content, isError]) => ({ type: "tool_result", toolCallId, content, isError: isError ?? false })) });
const thinking = (text: string, extra: Partial<ThinkingContent> = {}): ThinkingContent => ({ type: "thinking", text, provider: "openai-responses", ...extra }); const textBlock = (text: string, textSignature?: string): TextContent => ({ type: "text", text, ...(textSignature ? { textSignature } : {}) });
const callBlock = (id: string, name: string, input: Record<string, unknown>, itemId?: string): ToolCallContent => ({ type: "tool_call", id, name, input, ...(itemId ? { itemId } : {}) });
const userInput = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }); const userImageInput = (text: string, url: string) => ({ role: "user", content: [{ type: "input_image", detail: "auto", image_url: url }, { type: "input_text", text }] });
const messageItem = (text: string, id: string, extra: Record<string, unknown> = {}) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed", id, ...extra });
const reasoningInput = (text: string) => ({ type: "reasoning", content: [{ type: "reasoning_text", text }] });
const fcInput = (callId: string, name: string, input: Record<string, unknown>, itemId?: string) => ({ type: "function_call", call_id: callId, name, arguments: JSON.stringify(input), ...(itemId ? { id: itemId } : {}) }); const fcOutput = (callId: string, output: string) => ({ type: "function_call_output", call_id: callId, output });
// SSE 事件工厂：多个事件可压在一行
const usageInfo = (input: number, output: number, details?: Record<string, unknown>) => ({ input_tokens: input, output_tokens: output, ...(details ? { input_tokens_details: details } : {}) }); const completed = (output: unknown[] = [], usage?: unknown) => ({ type: "response.completed", response: { status: "completed", output, ...(usage ? { usage } : {}) } });
const textDelta = (text: string, outputIndex = 0) => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: outputIndex, delta: text });
const reasoningDelta = (text: string, itemId = "rs_1", type = "response.reasoning_summary_text.delta") => ({ type, item_id: itemId, output_index: 0, delta: text });
const itemAdded = (item: Record<string, unknown>, outputIndex = 0) => ({ type: "response.output_item.added", output_index: outputIndex, item });
const itemDone = (item: Record<string, unknown>, outputIndex = 0) => ({ type: "response.output_item.done", output_index: outputIndex, item });
const callDelta = (delta: string, itemId = "fc_1", outputIndex = 0) => ({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta });
const reasoningItemOf = (id: string, text: string) => ({ type: "reasoning", id, status: "completed", content: [{ type: "reasoning_text", text, annotations: [] }] });
const fcOf = (id: string, callId: string, name: string, args: string) => ({ id, type: "function_call", call_id: callId, name, arguments: args });

describe("OpenAIResponsesProvider streaming", () => {
  it("文本 delta、usage（cached/cache_write 归并并钳零）与终态映射（end_turn/incomplete→max_tokens/refusal）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const events = await collect(makeProvider(sseFetch(bodies, sse([textDelta("你好"), textDelta("世界"), completed([], usageInfo(100, 20, { cached_tokens: 30 }))]))).streamChat(request()));
    expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "你好" }, { type: "text_delta", text: "世界" }]); expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 70, outputTokens: 20, cacheRead: 30, cacheWrite: 0 });
    expect([events.at(-1), bodies[0]]).toMatchObject([{ type: "done", stopReason: "end_turn" }, { model: "gpt-5.4", stream: true, instructions: "system", input: [] }]);
    // cache_write 上报；cached+cacheWrite 超过 input 时钳到 0（不抛错）；负数仍是确定性错误（沿用 cached_tokens 口径）
    const withCacheWrite = (details: Record<string, unknown>) => collect(makeProvider(sseFetch([], sse([completed([], usageInfo(10, 5, details))]))).streamChat(request()));
    expect((await withCacheWrite({ cached_tokens: 6, cache_write_tokens: 8 })).find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 0, outputTokens: 5, cacheRead: 6, cacheWrite: 8 });
    await expect(withCacheWrite({ cache_write_tokens: -1 })).rejects.toThrow(/invalid cache write token usage/);
    const last = (list: Array<Record<string, unknown>>) => collect(makeProvider(sseFetch([], sse(list))).streamChat(request()));
    const truncated = await last([textDelta("半句"), { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } }]); expect(truncated.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
    // refusal.delta 既置 sawRefusal 又按 message 文本槽发 text_delta
    const refusal = await last([{ type: "response.refusal.delta", item_id: "msg_1", output_index: 0, delta: "不能" }, { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, delta: "说" }, completed()]);
    expect(refusal.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "不能" }, { type: "text_delta", text: "说" }]); expect(refusal.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });
  it("reasoning 映射：delta → thinking_delta，thinking_end 携带完整签名 item 与拼接后的权威文本", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const events = await collect(makeProvider(sseFetch(bodies, sse([reasoningDelta("先想"), reasoningDelta("再想"), textDelta("答", 1), completed([], usageInfo(10, 5))]))).streamChat(request({ effort: "high" })));
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "先想" }, { type: "thinking_delta", text: "再想" }]); expect(bodies[0]).toMatchObject({ reasoning: { effort: "high", summary: "auto" } });
    // reasoning_text 累积 + output_item.done 权威 item → thinking_end.signature 完整原样 JSON；function_call 透传 fc_ item id
    const item = reasoningItemOf("rs_ab12", "先分析再行动");
    const fcItem = fcOf("fc_111", "call_1", "bash", "{\"cmd\":\"ls\"}");
    const second = await collect(makeProvider(sseFetch([], sse([
      itemAdded({ type: "reasoning", id: "rs_ab12" }), reasoningDelta("先分析", "rs_ab12", "response.reasoning_text.delta"), reasoningDelta("再行动", "rs_ab12", "response.reasoning_text.delta"),
      itemAdded({ id: "fc_111", type: "function_call", call_id: "call_1", name: "bash" }, 1), callDelta("{\"cmd\":\"ls\"}", "fc_111", 1),
      itemDone(item), itemDone({ ...fcItem, status: "completed" }, 1), completed([item, fcItem], usageInfo(10, 5, { cached_tokens: 2 })),
    ]))).streamChat(request()));
    const thinkingEnds = second.filter((event) => event.type === "thinking_end") as Array<{ text: string; signature?: string }>; expect(thinkingEnds.map((event) => [event.text, JSON.parse(event.signature ?? "{}")])).toEqual([["先分析再行动", item]]);
    expect(second.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_1", itemId: "fc_111", name: "bash", input: { cmd: "ls" } }]);
    // summary_part.done 追加 "\n\n" 片段；output_item.done 的 content parts 以 \n\n 拼接为权威文本
    const joined = await collect(makeProvider(sseFetch([], sse([
      reasoningDelta("想"), { type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0 }, reasoningDelta("再想"),
      itemDone({ type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "想" }, { type: "reasoning_text", text: "再想" }] }), completed([], usageInfo(10, 5)),
    ]))).streamChat(request()));
    expect(joined.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "想" }, { type: "thinking_delta", text: "\n\n" }, { type: "thinking_delta", text: "再想" }]);
    expect((joined.find((event) => event.type === "thinking_end") as { text: string }).text).toBe("想\n\n再想");
  });
  it("reasoning summary/effort 受 provider 级开关门控；B3 加密密文回填第二次 thinking_end", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(sseFetch(bodies, COMPLETED), { reasoningContent: false }).streamChat(request({ effort: "low" })));
    await drain(makeProvider(sseFetch(bodies, COMPLETED), { reasoningEffort: false }).streamChat(request({ effort: "low" }))); expect(bodies[0]).toMatchObject({ reasoning: { effort: "low" } }); expect(bodies[0]?.reasoning).not.toHaveProperty("summary");
    expect(bodies[1]).toMatchObject({ reasoning: { summary: "auto" } }); expect(bodies[1]?.reasoning).not.toHaveProperty("effort");
    // B3：completed output 带 encrypted_content 而持久化签名缺失 → 补发第二次 thinking_end（密文合并进签名）
    const item = reasoningItemOf("rs_b3", "思考");
    const encrypted = { ...item, encrypted_content: "base64-encrypted" };
    const ends = (await collect(makeProvider(sseFetch([], sse([itemAdded({ type: "reasoning", id: "rs_b3" }), reasoningDelta("思考", "rs_b3", "response.reasoning_text.delta"), itemDone(item), completed([encrypted], usageInfo(10, 5))]))).streamChat(request())))
      .filter((event) => event.type === "thinking_end") as Array<{ text: string; signature?: string }>;
    expect(ends.map((event) => [event.text, JSON.parse(event.signature ?? "{}")])).toEqual([["思考", item], ["思考", encrypted]]);
  });
  it("function_call 事件产出：参数 delta 聚合；无 delta 时从 completed output 恢复", async () => {
    const events = await collect(makeProvider(sseFetch([], sse([itemAdded({ id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "" }), callDelta("{\"cmd\":"), callDelta("\"ls\"}"), { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"cmd\":\"ls\"}" }, completed([], usageInfo(10, 5))]))).streamChat(request()));
    const expectedDeltas = ["", "{\"cmd\":", "\"ls\"}"]; expect(events.filter((event) => event.type === "tool_call_delta")).toEqual(expectedDeltas.map((argumentsDelta) => ({ type: "tool_call_delta", id: "call_1", name: "bash", argumentsDelta })));
    expect(events.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_1", itemId: "fc_1", name: "bash", input: { cmd: "ls" } }]); expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
    const recovered = await collect(makeProvider(sseFetch([], sse([completed([fcOf("fc_9", "call_9", "read_file", "{\"path\":\"a.ts\"}")])]))).streamChat(request()));
    expect(recovered.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", id: "call_9", itemId: "fc_9", name: "read_file", input: { path: "a.ts" } }]); expect(recovered.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });
  it("HTTP 错误、response.failed 与传输中断均以 ProviderError 抛出", async () => {
    expect((await expectProviderError(makeProvider(sseFetch([], "invalid key", 401)).streamChat(request()))).kind).toBe("authentication");
    const failed = await expectProviderError(makeProvider(rawFetch(sse([textDelta("x"), { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } }]))).streamChat(request())); expect(failed.message).toContain("boom");
    // 第一片正常送达后再出错（error 会清空未读队列，不能在 start 里同步 error）
    let sentFirstChunk = false;
    const interrupted = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentFirstChunk) return controller.error(new Error("socket hang up"));
        sentFirstChunk = true;
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n'));
      },
    }), { status: 200 })) as unknown as typeof globalThis.fetch;
    expect((await expectProviderError(makeProvider(interrupted).streamChat(request()))).kind).toBe("stream_interrupted");
  });
  it("output_item.done 权威文本：补发缺失后缀、重复 delta 不重发；text_end 以权威为准", async () => {
    const signature = JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" });
    // 端点把剩余文本仅在 output_item.done 给出（未逐片流式）
    const doneItem = { id: "msg_1", phase: "final_answer", type: "message", status: "completed", content: [{ type: "output_text", text: "你好世界", annotations: [] }] };
    const eventsFor = (deltas: string[]) => collect(makeProvider(sseFetch([], sse([itemAdded({ id: "msg_1", type: "message" }), ...deltas.map((delta) => textDelta(delta)), itemDone(doneItem), completed([], usageInfo(10, 5))]))).streamChat(request()));
    const events = await eventsFor(["你好"]); expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "你好" }, { type: "text_delta", text: "世界" }]);
    expect(events.find((event) => event.type === "text_end")).toEqual({ type: "text_end", text: "你好世界", signature });
    // B7：累积超出权威（端点重复下发 delta）时不重发完整文本，text_end 仍以权威为准
    const duplicated = await eventsFor(["你好世界", "你好世界"]); expect(duplicated.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "你好世界" }, { type: "text_delta", text: "你好世界" }]);
    expect(duplicated.find((event) => event.type === "text_end")).toEqual({ type: "text_end", text: "你好世界", signature });
  });
});

describe("OpenAIResponsesProvider request mapping", () => {
  it("messages→input items：instructions 拼接、tools 扁平化、user parts 保序（text/image detail:auto）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await collect(makeProvider(sseFetch(bodies, COMPLETED), { maxTokens: 4096 }).streamChat(request({
      systemSuffix: "动态尾部", tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
      messages: [
        { id: "u1", role: "user", content: [{ type: "image", mediaType: "image/png", data: "aGk=" }, { type: "text", text: "看图" }], createdAt: at(0) },
        assistantMsg([textBlock("我查一下"), callBlock("call_1", "bash", { cmd: "ls" })]), toolMsg([["call_1", "ok"]]),
      ],
    })));
    expect([bodies[0]?.instructions, bodies[0]?.max_output_tokens, bodies[0]?.tools]).toEqual(["system\n\n动态尾部", 4096, [{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }]]);
    // user 消息恒为 parts 数组且按原始块序；缺同源 thinking 素材的 assistant 轮不回传 reasoning
    expect(bodies[0]?.input).toEqual([userImageInput("看图", "data:image/png;base64,aGk="), messageItem("我查一下", deriveMessageItemId("a1:0")), fcInput("call_1", "bash", { cmd: "ls" }), fcOutput("call_1", "ok")]);
    const partsBodies: Array<Record<string, unknown>> = [];
    await drain(makeProvider(sseFetch(partsBodies, COMPLETED)).streamChat(request({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "先" }, { type: "image", mediaType: "image/jpeg", data: "eA==" }, { type: "text", text: "后" }], createdAt: at(0) }] })));
    expect(partsBodies[0]?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "先" }, { type: "input_image", detail: "auto", image_url: "data:image/jpeg;base64,eA==" }, { type: "input_text", text: "后" }] }]);
  });
  it("请求体选项：sampling 透传/推理档抑制、extraBody 合并、store 与 max_output_tokens 缺省钳制、include 门控、thinking=disabled→effort:none", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const run = (options: Record<string, unknown> = {}, overrides: Partial<StreamChatRequest> = {}) => drain(makeProvider(sseFetch(bodies, COMPLETED), options).streamChat(request(overrides)));
    await run({}, { temperature: 0.7, topP: 0.9 }); expect(bodies[0]).toMatchObject({ temperature: 0.7, top_p: 0.9 });
    // 缺省省略 store（兼容不支持该字段的端点）与空 tools
    expect([bodies[0]?.store, bodies[0]?.max_output_tokens, bodies[0]?.tools]).toEqual([undefined, undefined, undefined]);
    // 推理档端点拒绝 sampling 参数：携带 effort 时不下发，避免 400
    await run({}, { temperature: 0.7, topP: 0.9, effort: "low" }); expect([bodies[1]?.temperature, bodies[1]?.top_p]).toEqual([undefined, undefined]);
    await run({ extraBody: { temperature: 0.7, model: "evil-override", store: false } }); // extraBody 浅合并，核心字段优先
    await run({ store: true, maxTokens: 8 }); // 低于下限时钳到 16
    await run({ maxTokens: 4096 }); expect([bodies[2]?.model, bodies[2]?.temperature, bodies[2]?.store, bodies[3]?.max_output_tokens, bodies[4]?.max_output_tokens]).toEqual(["gpt-5.4", 0.7, false, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, 4096]);
    // include 仅当 responsesEncryptedReplay 且 (reasoningContent||effort)
    await run({}, { effort: "high" });
    await run({}, { responsesEncryptedReplay: true, effort: "high" });
    await run({}, { responsesEncryptedReplay: true, reasoningContent: true });
    await run({}, { responsesEncryptedReplay: true, reasoningContent: false }); expect(bodies.slice(5).map((body) => body.include)).toEqual([undefined, ["reasoning.encrypted_content"], ["reasoning.encrypted_content"], undefined]);
    // thinking=disabled 且声明 thinking 型 → effort:none；effort_only 型与未声明 thinkingStyle 均不下发
    const disabledMatrix: Array<Partial<StreamChatRequest>> = [
      { model: "deepseek-v4-pro", thinking: "disabled", effort: "max", thinkingStyle: "thinking" }, { model: "deepseek-v4-pro", thinking: "enabled", effort: "high", thinkingStyle: "thinking" },
      { model: "gpt-5", thinking: "disabled", thinkingStyle: "effort_only" }, { model: "deepseek-v4-pro", thinking: "disabled" },
    ];
    for (const overrides of disabledMatrix) await run({}, overrides); expect(bodies.slice(9).map((body) => body.reasoning ?? null)).toEqual([{ effort: "none", summary: "auto" }, { effort: "high", summary: "auto" }, null, null]);
  });
  it("思维链回放：reasoning 合并置于 assistant message 之前（异源过滤、并行 function_call 全前置）、signature 剥壳、关闭后不回传", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const conversation: StreamChatRequest["messages"] = [
      userMsg("继续"),
      assistantMsg([thinking("先分析"), thinking("异源思维", { provider: "other-provider" }), textBlock("我查一下"), callBlock("call_1", "read_file", { path: "a" }), callBlock("call_2", "bash", { cmd: "ls" })]),
      toolMsg([["call_1", "A"]], 2, "t1"), toolMsg([["call_2", "B"]], 3, "t2"),
    ];
    // DeepSeek 规范序：reasoning 置于 message item 之前，并行 function_call 全前置（fc…fc → fco…fco，真机验证）
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: conversation })));
    const withReasoning = [userInput("继续"), reasoningInput("先分析"), messageItem("我查一下", deriveMessageItemId("a1:0")), fcInput("call_1", "read_file", { path: "a" }), fcInput("call_2", "bash", { cmd: "ls" }), fcOutput("call_1", "A"), fcOutput("call_2", "B")];
    expect(bodies[0]?.input).toEqual(withReasoning);
    // 请求级关闭：不回传（与 openai-compatible 的 reasoningContent=false 同语义）
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: conversation, reasoningContent: false }))); expect(bodies[1]?.input).toEqual(withReasoning.filter((entry) => entry.type !== "reasoning"));
    // 持久化 signature 提供权威 reasoning_text，但回放剥掉 id/status/annotations（DeepSeek 输入只支持 plain-text
    // content）；function_call 只带 call_id 并保留原始 fc_* item id，兼容严格网关配对校验
    const signature = JSON.stringify({ type: "reasoning", id: "rs_abc123", status: "completed", content: [{ type: "reasoning_text", text: "先分析", annotations: [] }] });
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: [userMsg("继续"), assistantMsg([thinking("先分析", { signature }), textBlock("我查一下"), callBlock("call_1", "bash", { cmd: "ls" }, "fc_xyz789")]), toolMsg([["call_1", "A"]])] })));
    expect(bodies[2]?.input).toEqual([userInput("继续"), reasoningInput("先分析"), messageItem("我查一下", deriveMessageItemId("a1:0")), fcInput("call_1", "bash", { cmd: "ls" }, "fc_xyz789"), fcOutput("call_1", "A")]);
  });
  it("tool_result 配对与尾部占位：悬空 tool_call/游离 tool_result 不回放；末条 assistant 无 thinking 素材时补占位并留痕", async () => {
    const lines: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    // 留痕经构造注入收集器，不依赖模块级全局状态
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: sseFetch(bodies, COMPLETED), diagnosticWriter: (line) => lines.push(line) });
    // 中断时结果未落盘（call_dangling 无结果）；游离 tool_result 无对应 assistant 调用 —— 两者都不回放
    await collect(provider.streamChat(request({ messages: [userMsg("继续"), assistantMsg([callBlock("call_dangling", "bash", { cmd: "sleep 600" })]), toolMsg([["call_orphan", "orphan"]], 2, "t2")] }))); expect(bodies[0]?.input).toEqual([userInput("继续")]);
    // 控制：末条是 tool 消息（结果已落盘）时正常回放且不留痕
    await collect(provider.streamChat(request({ messages: [userMsg("继续"), assistantMsg([textBlock("我查一下"), callBlock("call_tail", "bash", { cmd: "ls" })], 1, "a_tail"), toolMsg([["call_tail", "B"]])] })));
    expect(bodies[1]?.input).toEqual([userInput("继续"), messageItem("我查一下", deriveMessageItemId("a_tail:0")), fcInput("call_tail", "bash", { cmd: "ls" }), fcOutput("call_tail", "B")]); expect(lines).toEqual([]);
    // 触发：末条是 assistant 且无 thinking 素材 → 尾部补占位 reasoning（置于 message item 前，DeepSeek 尾部校验）
    await collect(provider.streamChat(request({ messages: [userMsg("继续"), assistantMsg([textBlock("结论：完成")], 1, "a_tail2")] }))); expect(bodies[2]?.input).toEqual([userInput("继续"), reasoningInput(PLACEHOLDER_REASONING_TEXT), messageItem("结论：完成", deriveMessageItemId("a_tail2:0"))]);
    expect(lines.some((line) => line.includes("缺同源 thinking 素材"))).toBe(true);
  });
  it("serverWebSearch 附加 tools 并映射 server_tool/web_search_call 事件；web_search_call 块原样回传", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const wsItem = { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", queries: ["北京天气"] } };
    const events = await collect(makeProvider(sseFetch(bodies, sse([
      { type: "response.web_search_call.in_progress", item_id: "ws_1" }, { type: "response.web_search_call.searching", item_id: "ws_1" }, { type: "response.web_search_call.completed", item_id: "ws_1" },
      textDelta("找到了"), itemDone(wsItem, 1), completed([{ id: "ws_1", type: "web_search_call" }], usageInfo(10, 5)),
    ]))).streamChat(request({ serverWebSearch: true })));
    expect(bodies[0]?.tools).toEqual([{ type: "web_search" }]); expect(events.filter((event) => event.type === "server_tool").map((event) => event.phase)).toEqual(["start", "update", "end"]); // 无 function tools 也发送 tools 字段
    // 完整 web_search_call item 落盘事件（output_item.done 权威值，completed 兜底去重）；不产出 tool_call、不影响 stopReason
    expect(events.filter((event) => event.type === "web_search_call")).toEqual([{ type: "web_search_call", item: wsItem }]); expect([events.some((event) => event.type === "tool_call"), events.at(-1)]).toEqual([false, { type: "done", stopReason: "end_turn" }]);
    // 与 function tools 并存时 web_search 附加在末尾
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ serverWebSearch: true, tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }] })));
    expect(bodies[1]?.tools).toEqual([{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }, { type: "web_search" }]);
    // web_search_call 块回放：非加密与加密路径均原样回传（Pass back as-is，服务端据此恢复搜索结果）
    const replayItem = { type: "web_search_call", id: "call_00_ws1", status: "completed", action: { type: "search", queries: ["北京天气"] } };
    // 交错：web_search_call 块按流式到达顺序夹在 thinking 之后、text 之前
    const replay: StreamChatRequest["messages"] = [userMsg("今天北京天气如何"), assistantMsg([thinking("先搜索"), { type: "web_search_call", signature: JSON.stringify(replayItem), id: replayItem.id, status: replayItem.status }, textBlock("今天北京多云转阴。")])];
    const answer = messageItem("今天北京多云转阴。", deriveMessageItemId("a1:0"));
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: replay }))); expect(bodies[2]?.input).toEqual([userInput("今天北京天气如何"), reasoningInput("先搜索"), replayItem, answer]);
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: replay, responsesEncryptedReplay: true }))); expect(bodies[3]?.input).toEqual([userInput("今天北京天气如何"), replayItem, answer]);
    // 非法签名跳过（后随 user 消息，非尾部，不触发占位）
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages: [userMsg("hi"), assistantMsg([{ type: "web_search_call", signature: "not-json", id: "x" }]), userMsg("再问", 2, "u2")] }))); expect(bodies[4]?.input).toEqual([userInput("hi"), userInput("再问")]);
  });
  it("加密回放：reasoning/message item id/phase/function_call item id 原样回放；非加密口径剥离并合并", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const reasoningItem = reasoningItemOf("rs_enc1", "加密思维");
    const signature = JSON.stringify({ v: 1, id: "msg_enc1", phase: "commentary" });
    const messages: StreamChatRequest["messages"] = [
      userMsg("继续"),
      assistantMsg([
        thinking("加密思维", { signature: JSON.stringify(reasoningItem) }), thinking("无签名思维"), // 无签名同源 thinking：加密模式跳过（不补占位）
        textBlock("我查一下", signature), textBlock("再补充"), // 无 textSignature：派生稳定 msg_ id（sha1("a1:1")）
        callBlock("call_1", "bash", { cmd: "ls" }, "fc_enc1"), callBlock("call_2", "read_file", { path: "a" }, "ctc_2"), // 非 fc_ 前缀：不派发 id
      ]),
      toolMsg([["call_1", "A"]], 2, "t1"),
      toolMsg([["call_2", "B"]], 3, "t2"),
    ];
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages, responsesEncryptedReplay: true })));
    // 带签名的同源 thinking 完整 item 原样回放（含 rs id / annotations）；无 textSignature 的文本块派生稳定 msg_ id
    expect(bodies[0]?.input).toEqual([
      userInput("继续"), reasoningItem, messageItem("我查一下", "msg_enc1", { phase: "commentary" }), messageItem("再补充", deriveMessageItemId("a1:1")),
      fcInput("call_1", "bash", { cmd: "ls" }, "fc_enc1"), fcOutput("call_1", "A"), fcInput("call_2", "read_file", { path: "a" }), fcOutput("call_2", "B"),
    ]);
    // 关闭加密回放：DeepSeek 口径——逐 thinking 块一条 plain-text reasoning 前置，文本合并为一条 message item（id/phase 取自 textSignature）
    await collect(makeProvider(sseFetch(bodies, COMPLETED)).streamChat(request({ messages, responsesEncryptedReplay: false }))); expect(bodies[1]?.input).toEqual([
      userInput("继续"), reasoningInput("加密思维"), reasoningInput("无签名思维"), messageItem("我查一下再补充", "msg_enc1", { phase: "commentary" }),
      fcInput("call_1", "bash", { cmd: "ls" }, "fc_enc1"), fcInput("call_2", "read_file", { path: "a" }), fcOutput("call_1", "A"), fcOutput("call_2", "B"),
    ]);
  });
});

describe("ProviderProfilesRuntime openai-responses branch", () => {
  it("openai-responses 档案按 DEFAULT_MAX_CONCURRENT 包装注册", async () => {
    const root = await tempRoot("owc-responses-profile-");
    const service = await ProviderProfilesService.load({ filePath: path.join(root, "provider-profiles.json") });
    const providers = new ProviderRegistry();
    const agent = { setSearchProvider() { /* noop */ }, setWebFetchProvider() { /* noop */ } } as unknown as AgentRunner;
    const runtime = new ProviderProfilesRuntime(service, providers, agent, undefined, new EventBus());
    runtime.start();
    try {
      await service.upsertModel(undefined, { id: "GPT", enabled: true, interfaceType: "openai-responses", baseURL: "https://api.openai.test/v1", apiKey: "sk-test" });
      // 生产注册路径按并发上限包装：get 返回限流包装器（name 透传，底层为 OpenAIResponsesProvider）
      expect(providers.get("GPT")).toBeInstanceOf(ConcurrencyLimitedProvider); expect([providers.get("GPT")?.name, providers.concurrencyStats()["GPT"]]).toEqual(["GPT", { active: 0, queued: 0, maxConcurrent: DEFAULT_MAX_CONCURRENT }]);
    } finally { runtime.stop(); }
  });
});

describe("provider reasoning / extraBody 请求体", () => {
  it("anthropic thinking/effort 无硬编码默认、cache 断点、budget 下限；compat reasoning_effort、空 tools、请求级 reasoningContent 覆盖；extraBody 优先级", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies);
    await drain(provider.streamChat(reasoningRequest({ thinking: "adaptive", effort: "xhigh" })));
    await drain(provider.streamChat(reasoningRequest({ thinking: "disabled" })));
    await drain(provider.streamChat(reasoningRequest({ thinking: "enabled" })));
    await drain(provider.streamChat(reasoningRequest({ cacheBreakpoints: ["u1"], messages: [userMsg("cached"), userMsg("tail", 1, "u2")] }))); expect(bodies[0]).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect([bodies[1]?.thinking, bodies[1]?.output_config]).toEqual([undefined, undefined]);
    // 未声明 thinkingStyle：按模型名推断（claude-opus-4-8 为 4.6+ → adaptive，预算已在该代弃用）
    expect(bodies[2]).toMatchObject({ thinking: { type: "adaptive" } }); expect(bodies[3]).toMatchObject({ messages: [{ content: [{ text: "cached", cache_control: { type: "ephemeral" } }] }, { content: [{ text: "tail" }] }] });
    // 声明 extended（claude 4.5 及以前形态）或按模型名推断为旧代：budget = maxTokens 减 1/8 正文余量，至少留 1024
    await drain(provider.streamChat(reasoningRequest({ thinking: "enabled", thinkingStyle: "extended" })));
    await drain(provider.streamChat(reasoningRequest({ model: "claude-opus-4-5", thinking: "enabled" })));
    const limited = new AnthropicProvider({ apiKey: "test", maxTokens: 8000 });
    injectMockStream(limited, bodies);
    await drain(limited.streamChat(reasoningRequest({ thinking: "enabled", thinkingStyle: "extended" })));
    // 国产/未知模型 anthropic 路径默认 adaptive
    await drain(provider.streamChat(reasoningRequest({ model: "deepseek-v4-pro", thinking: "enabled" }))); expect(bodies.slice(4).map((body) => body.thinking)).toEqual([
      { type: "enabled", budget_tokens: 56_000 }, { type: "enabled", budget_tokens: 56_000 },
      { type: "enabled", budget_tokens: 6976 }, { type: "adaptive", display: "summarized" },
    ]);
    expect(bodies[6]).toMatchObject({ max_tokens: 8000 }); // 8000/8 = 1000 < 1024 下限
    const compatBodies: Array<Record<string, unknown>> = [];
    const compat = (options: Record<string, unknown> = {}) => makeCompat(sseFetch(compatBodies, "data: [DONE]\n\n"), options);
    await drain(compat().streamChat(reasoningRequest({ effort: "high" })));
    await drain(compat({ reasoningEffort: false }).streamChat(reasoningRequest({ effort: "high" })));
    await drain(compat().streamChat(reasoningRequest()));
    await drain(provider.streamChat(reasoningRequest())); expect(compatBodies[0]).toMatchObject({ reasoning_effort: "high" }); expect([compatBodies[1]?.reasoning_effort, compatBodies[2]?.tools, bodies[8]?.tools]).toEqual([undefined, undefined, undefined]); // 两家都不虚报空 tools
    // 请求级 reasoningContent 覆盖 provider 级默认（异源 thinking 过滤 + 同源回传）
    const reasoningMessages: StreamChatRequest["messages"] = [assistantMsg([thinking("想一下", { provider: "compat" }), textBlock("答")])];
    await drain(makeCompat(sseFetch(compatBodies, "data: [DONE]\n\n"), { name: "compat" }).streamChat(reasoningRequest({ messages: reasoningMessages, reasoningContent: false })));
    await drain(makeCompat(sseFetch(compatBodies, "data: [DONE]\n\n"), { name: "compat", reasoningContent: false }).streamChat(reasoningRequest({ messages: reasoningMessages, reasoningContent: true })));
    expect((compatBodies[3]!.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty("reasoning_content"); expect((compatBodies[4]!.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ reasoning_content: "想一下" });
    // extraBody：request.maxTokens > extraBody.max_tokens > provider 默认；compat 显式 maxTokens → max_tokens
    const extraProvider = new AnthropicProvider({ apiKey: "test", extraBody: { temperature: 0.3, max_tokens: 128_000 } });
    const extraBodies: Array<Record<string, unknown>> = [];
    injectMockStream(extraProvider, extraBodies);
    await drain(extraProvider.streamChat(reasoningRequest()));
    await drain(extraProvider.streamChat(reasoningRequest({ maxTokens: 256 }))); expect(extraBodies[0]).toMatchObject({ model: "claude-opus-4-8", temperature: 0.3, max_tokens: 128_000 }); expect(extraBodies[1]).toMatchObject({ max_tokens: 256 });
    const compatLimited: Array<Record<string, unknown>> = [];
    await drain(makeCompat(sseFetch(compatLimited, "data: [DONE]\n\n"), { maxTokens: 4096 }).streamChat(reasoningRequest())); expect(compatLimited[0]).toMatchObject({ max_tokens: 4096 });
  });
  it("anthropic tool_call_delta：content_block_start 与 input_json_delta 聚合为单个 tool_call", async () => {
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
        return { content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "tool_use" };
      },
    });
    (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    const events = await collect(provider.streamChat(reasoningRequest())); expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", id: "tu_1", name: "read_file", argumentsDelta: "" },
      { type: "tool_call_delta", id: "tu_1", argumentsDelta: "{\"path\":" },
      { type: "tool_call_delta", id: "tu_1", argumentsDelta: "\"a.ts\"}" },
    ]);
    expect(events.some((event) => event.type === "tool_call" && event.id === "tu_1")).toBe(true);
  });
});

describe("SSE 空闲超时", () => {
  const idleEvent = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
  const idleResponse = (pump: (controller: ReadableStreamDefaultController<Uint8Array>) => void) =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) { pump(controller); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  it("心跳注释不续命（判半开连接、可重试）；持续 data 重置计时；streamIdleTimeoutMs=0 交由调用方中止", async () => {
    const heartbeat = (async () => idleResponse((controller) => {
      controller.enqueue(encoder.encode(idleEvent({ choices: [{ delta: { content: "hi" } }] })));
      const timer = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(timer); } }, 20);
    })) as unknown as typeof globalThis.fetch;
    const error = await expectProviderError(makeCompat(heartbeat, { streamIdleTimeoutMs: 100 }).streamChat(idleRequest())); expect([error.kind, error.retryable]).toEqual(["stream_interrupted", true]); expect(error.message).toMatch(/half-open/);
    // 间隔 40ms < 上限 200ms：流虽慢但持续有 data，不应触发超时
    const slow = (async () => idleResponse((controller) => {
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        try {
          if (step <= 5) controller.enqueue(encoder.encode(idleEvent({ choices: [{ delta: { content: `t${step}` } }] })));
          else if (step === 6) controller.enqueue(encoder.encode(idleEvent({ choices: [{ delta: {}, finish_reason: "stop" }] })));
          else { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); clearInterval(timer); } // 更快的心跳不续命，只有 data 会重置计时
        } catch { clearInterval(timer); }
      }, 40);
    })) as unknown as typeof globalThis.fetch;
    const events = await collect(makeCompat(slow, { streamIdleTimeoutMs: 200 }).streamChat(idleRequest())); expect(events.filter((event) => event.type === "text_delta")).toHaveLength(5); expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    // 完全静默的流：0 关闭内部超时，由调用方 signal 中止（真实 fetch 会把中止传导到响应体，假流手动复现）
    const silent = (async (_input: unknown, init?: RequestInit) => idleResponse((controller) => {
      controller.enqueue(encoder.encode(idleEvent({ choices: [{ delta: { content: "hi" } }] })));
      init?.signal?.addEventListener("abort", () => { try { controller.error(new DOMException("The operation was aborted", "AbortError")); } catch { /* 已关闭 */ } });
    })) as unknown as typeof globalThis.fetch;
    const controller = new AbortController();
    const run = makeCompat(silent, { streamIdleTimeoutMs: 0 }).streamChat({ ...idleRequest(), signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    await expect(collect(run)).rejects.toThrow();
  });
});

describe("provider 错误分类与错误体截断", () => {
  it("HTTP/SSE 错误分类、failure code 可重试性、截断工具参数与错误体截断", async () => {
    expect((await expectProviderError(makeProvider(sseFetch([], "invalid key", 401)).streamChat(errorRequest()))).kind).toBe("authentication");
    expect((await expectProviderError(makeProvider(rawFetch(eventBody({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } }))).streamChat(errorRequest()))).message).toContain("boom");
    const cases: Array<[Record<string, unknown>, string, boolean]> = [
      [{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } }, "overloaded", true],
      [{ type: "error", code: "rate_limit", message: "slow down" }, "rate_limit", true],
      [{ type: "error", code: "rate_limit_exceeded", message: "slow down" }, "rate_limit", true],
      [{ type: "response.failed", response: { status: "failed", error: { code: "overloaded", message: "busy" } } }, "overloaded", true],
      [{ type: "response.failed", response: { status: "failed", error: { code: "invalid_request", message: "bad" } } }, "unknown", false],
    ];
    const classified: Array<[string, boolean]> = [];
    for (const [event] of cases) {
      const error = await expectProviderError(makeProvider(rawFetch(eventBody(event))).streamChat(errorRequest()));
      classified.push([error.kind, error.retryable]);
    }
    expect(classified).toEqual(cases.map(([, kind, retryable]) => [kind, retryable]));
    // 截断的工具参数 JSON 归 invalid_request（不可重试）：两家 provider 同判定
    const compatBody = eventBody({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{\"cmd\":" } }] } }] }) + eventBody({ choices: [{ finish_reason: "length", delta: {} }] }) + "data: [DONE]\n\n";
    const compatError = await expectProviderError(makeCompat(rawFetch(compatBody)).streamChat(errorRequest())); expect([compatError.kind, compatError.retryable]).toEqual(["invalid_request", false]);
    const responsesBody = eventBody({ type: "response.output_item.done", item_id: "fc_1", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":" } });
    const responsesError = await expectProviderError(makeProvider(rawFetch(responsesBody + sse([completed([], usageInfo(1, 1))]))).streamChat(errorRequest())); expect([responsesError.kind, responsesError.retryable]).toEqual(["invalid_request", false]);
    // 错误体超限截断为约 2000 字符（两家口径一致），未超限原样保留
    const detail = `{"error":"${"x".repeat(5_000)}"}`;
    const truncated = await expectProviderError(makeCompat(rawFetch(detail, 500)).streamChat(errorRequest())); expect([truncated.retryable, truncated.message.includes("…"), truncated.message.length < 2_100, truncated.message.includes(detail.slice(-20))]).toEqual([true, true, true, false]);
    const responsesTruncated = await expectProviderError(makeProvider(rawFetch(detail, 400)).streamChat(errorRequest()));
    expect([responsesTruncated.kind, responsesTruncated.retryable, responsesTruncated.message.includes("…"), responsesTruncated.message.length < 2_100]).toEqual(["invalid_request", false, true, true]);
    const shortError = await expectProviderError(makeCompat(rawFetch("short detail", 500)).streamChat(errorRequest())); expect([shortError.message.includes("short detail"), shortError.message.includes("…")]).toEqual([true, false]);
  });
});
describe("readSseData 边界与终态分类", () => {
  it("超字节上限判确定性协议错误；尾部残留按最后一个事件解析；[DONE] 哨兵区分正常收尾与静默截断", async () => {
    const oversize = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(`data: ${"x".repeat(MAX_SSE_EVENT_BYTES)}`)); } });
    const error = await expectProviderError(readSseData(oversize, { idleTimeoutMs: 0 }) as AsyncIterable<ProviderEvent>); expect([error.kind, error.retryable]).toEqual(["stream_interrupted", false]); expect(error.message).toMatch(/exceeded/);
    const tail = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("data: first\n\ndata: tail-without-terminator")); controller.close(); } });
    const data: string[] = [];
    for await (const chunk of readSseData(tail, { idleTimeoutMs: 0 })) data.push(chunk); expect(data).toEqual(["first", "tail-without-terminator"]);
    // 唯一 data 事件无 \n\n 结尾（端点提前关连接）：旧实现静默丢弃 → stopReason 误判 error
    const stopReasonOf = async (body: string) => (await collect(makeCompat(rawFetch(body)).streamChat(errorRequest()))).at(-1); expect(await stopReasonOf(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}`)).toEqual({ type: "done", stopReason: "end_turn" });
    // 只发哨兵不发 finish_reason 的网关：正常收尾（不得误判为截断而重试）
    expect(await stopReasonOf(eventBody({ choices: [{ delta: { content: "hi" } }] }) + "data: [DONE]\n\n")).toEqual({ type: "done", stopReason: "end_turn" });
    // 仅工具调用分片 + 哨兵：按 tool_use 收尾（agent 循环据 done 判定后续调度）
    expect(await stopReasonOf(eventBody({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{}" } }] } }] }) + "data: [DONE]\n\n")).toEqual({ type: "done", stopReason: "tool_use" });
    // 无 finish_reason 也无哨兵的 EOF：静默截断保持 error（collectProviderTurn 据此当失败重试）
    expect(await stopReasonOf(eventBody({ choices: [{ delta: { content: "半截" } }] }))).toEqual({ type: "done", stopReason: "error" });
  });
});
describe("OpenAICompatibleProvider 工具配对修复", () => {
  it("tool_result 内联到对应 assistant tool_calls 之后，重复 call id 只发一次", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const toolCall = callBlock("call_1", "read_file", { path: "a" });
    // 压缩/分支残留：同一 call id 在另一条 assistant 消息重复出现
    await drain(makeCompat(sseFetch(bodies, "data: [DONE]\n\n")).streamChat(reasoningRequest({ messages: [userMsg("查"), assistantMsg([textBlock("我查一下"), toolCall]), toolMsg([["call_1", "A"]]), assistantMsg([toolCall], 3, "a2")] }))); expect(bodies[0]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "查" },
      { role: "assistant", content: "我查一下", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "assistant", content: null },
    ]);
  });
});
