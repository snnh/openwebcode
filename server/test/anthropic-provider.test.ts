import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { ContextManager } from "../src/context/context-manager.js";
import { estimateMessageTokens, IMAGE_TOKEN_ESTIMATE } from "../src/context/model-profile.js";
import type { CoreClient } from "../src/core-client.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { ConcurrencyLimitedProvider, DEFAULT_MAX_CONCURRENT } from "../src/providers/concurrency-limiter.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { collectProviderTurn } from "../src/providers/retry.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";
const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const doneEvent: ProviderEvent = { type: "done", stopReason: "end_turn" };
function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
/** 捕获式 mock stream 的 provider：请求体进 bodies，options 注入 finalMessage。 */
function mockProvider(
  options: Parameters<typeof injectMockStream>[2] = {},
  init: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey: "test" },
): { provider: AnthropicProvider; bodies: Array<Record<string, unknown>> } {
  const provider = new AnthropicProvider(init);
  const bodies: Array<Record<string, unknown>> = [];
  injectMockStream(provider, bodies, options);
  return { provider, bodies };
}
const cacheMessage = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({ id, role, createdAt: at(0), content: [{ type: "text", text }] });
const cacheRequest = (overrides: Partial<StreamChatRequest> = {}): StreamChatRequest => request({ system: "stable system prefix", ...overrides });
const CACHE_TOOLS = [
  { name: "read", description: "Read a file", inputSchema: { type: "object" } },
  { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
];
/** 默认 finalMessage：文本 "ok" + 基础 usage（cache 字段经 usage 覆盖注入）。 */
const OK_MESSAGE = { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] };
/** 统计 body 内计入 API 断点上限（≤4）的 cache_control 数：system、tools、messages。 */
function apiBreakpoints(body: Record<string, unknown>): number {
  const walk = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum: number, item: unknown) => sum + walk(item), 0);
    if (!value || typeof value !== "object") return 0;
    const record = value as Record<string, unknown>;
    return (record.cache_control ? 1 : 0) + Object.values(record).reduce((sum, item) => sum + walk(item), 0);
  };
  return [body.system, body.tools, body.messages].reduce((sum, root) => sum + walk(root), 0);
}

describe("AnthropicProvider 消息与 thinking 映射", () => {
  it("异源 thinking 补占位 text；redacted_thinking 经 thinking_end 透出并原样回传", async () => {
    const { provider, bodies } = mockProvider({ content: [{ type: "redacted_thinking", data: "EhdHf8s…encrypted-payload" }, { type: "text", text: "答" }] });
    expect(await collect(provider.streamChat(request()))).toContainEqual({ type: "thinking_end", text: "", redacted: "EhdHf8s…encrypted-payload" });
    // 跨 provider 切换后的历史：assistant 只剩 deepseek 的 thinking 块，映射后 content 为空 → 补占位（否则 400）
    await collect(provider.streamChat(request({ messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "q" }], createdAt: at(0) },
      { id: "a1", role: "assistant", createdAt: at(1), content: [{ type: "thinking", text: "异源思考", provider: "deepseek" }] },
    ] })));
    expect((bodies[1]!.messages as Array<Record<string, unknown>>)[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "[context trimmed]" }] });
    // 持久化的 redacted thinking 下轮原样回传（缺块会 400）
    await collect(provider.streamChat(request({ messages: [
      { id: "a1", role: "assistant", createdAt: at(1), content: [{ type: "thinking", text: "", redacted: "EhdHf8s…encrypted-payload", provider: "anthropic" }, { type: "text", text: "答" }] },
    ] })));
    expect((bodies[2]!.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: "assistant", content: [{ type: "redacted_thinking", data: "EhdHf8s…encrypted-payload" }, { type: "text", text: "答" }] });
  });

  it("未声明 thinkingStyle 时按模型名推断（4.5 及以前 extended 带预算，4.6+/未知 adaptive 不带）；SDK 内建重试关闭", async () => {
    const { provider, bodies } = mockProvider(); expect((provider as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(0);
    // 8 位日期后缀不得被读成次版本（读成 20250514 会误判 adaptive → 400）
    const cases: Array<[string, "enabled" | "adaptive"]> = [
      ["claude-3-5-sonnet-20241022", "enabled"], ["claude-3-7-sonnet-20250219", "enabled"], ["claude-3-opus-20240229", "enabled"],
      ["claude-sonnet-4-20250514", "enabled"], ["claude-opus-4-1-20250805", "enabled"], ["claude-sonnet-4-5-20250929", "enabled"],
      ["claude-opus-4-6", "adaptive"], ["claude-sonnet-5", "adaptive"], ["deepseek-reasoner", "adaptive"],
    ];
    for (const [model] of cases) await collect(provider.streamChat(request({ model, thinking: "enabled" }))); expect(bodies.map((body) => (body.thinking as { type: string }).type)).toEqual(cases.map(([, type]) => type));
    expect(bodies[0]!.thinking).toMatchObject({ type: "enabled", budget_tokens: expect.any(Number) }); expect(bodies[6]!.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("Anthropic prompt cache 断点", () => {
  it("断点打在 system 稳定块、末位工具与消息前缀上（总额 ≤4），动态尾部不打", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    await collect(provider.streamChat(cacheRequest({ systemSuffix: "background task finished", tools: CACHE_TOOLS, cacheBreakpoints: ["u1"], messages: [cacheMessage("u1", "user", "first"), cacheMessage("u2", "user", "second")] })));
    const body = bodies[0]!;
    const system = body.system as Array<Record<string, unknown>>; expect(system).toHaveLength(2); expect(system[0]).toMatchObject({ text: "stable system prefix", cache_control: { type: "ephemeral" } });
    expect(system[1]).toMatchObject({ text: "background task finished" }); expect(system[1]).not.toHaveProperty("cache_control"); // 动态尾部独立成块且无断点
    const tools = body.tools as Array<Record<string, unknown>>; expect(tools[0]).not.toHaveProperty("cache_control"); expect(tools[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>; expect(messages[0]!.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } }); expect(messages[1]!.content.at(-1)).not.toHaveProperty("cache_control");
    expect(apiBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  it("消息级断点超出预算按 ≤4 总额截断（保留最前者）；关闭后零断点且 system 退化为字符串", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    await collect(provider.streamChat(cacheRequest({ tools: CACHE_TOOLS, messages: ["m1", "m2", "m3", "m4"].map((id) => cacheMessage(id, "user", id)), cacheBreakpoints: ["m1", "m2", "m3", "m4"] })));
    const body = bodies[0]!;
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>; expect(messages.filter((item) => item.content.at(-1)!.cache_control)).toHaveLength(2); expect(apiBreakpoints(body)).toBe(4); // system 1 + tools 1 → 消息预算 2
    // provider 级或请求级关闭：不打任何断点，system 退化为字符串拼接
    for (const init of [{ apiKey: "test", promptCaching: false }, { apiKey: "test" }] as const) {
      const off = mockProvider(OK_MESSAGE, init);
      await collect(off.provider.streamChat(cacheRequest({ ...(init.promptCaching === false ? {} : { promptCaching: false }), systemSuffix: "tail", tools: CACHE_TOOLS, cacheBreakpoints: ["u1"], messages: [cacheMessage("u1", "user", "hi")] })));
      expect(apiBreakpoints(off.bodies[0]!)).toBe(0); expect(off.bodies[0]!.system).toBe("stable system prefix\n\ntail");
    }
  });

  it("连续两 turn 稳定前缀逐字节一致，只有尾部变化", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    const history = [cacheMessage("u1", "user", "first"), cacheMessage("a1", "assistant", "reply")];
    await collect(provider.streamChat(cacheRequest({ systemSuffix: "notice one", tools: CACHE_TOOLS, cacheBreakpoints: ["u1"], messages: history })));
    await collect(provider.streamChat(cacheRequest({ systemSuffix: "notice two", tools: CACHE_TOOLS, cacheBreakpoints: ["u1"], messages: [...history, cacheMessage("u2", "user", "follow up")] })));
    const [first, second] = bodies as Array<Record<string, unknown>>; expect(JSON.stringify((second.system as unknown[])[0])).toBe(JSON.stringify((first.system as unknown[])[0])); expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify((second.messages as unknown[]).slice(0, (first.messages as unknown[]).length))).toBe(JSON.stringify(first.messages));
  });

  it("usage 映射 cache 读写字段（旧响应缺字段按 0）；temperature/topP 透传与缺省", async () => {
    const { provider, bodies } = mockProvider({ ...OK_MESSAGE, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 1500 } });
    expect((await collect(provider.streamChat(cacheRequest()))).find((event) => event.type === "usage")).toMatchObject({ inputTokens: 100, cacheRead: 800, cacheWrite: 1500 });
    injectMockStream(provider, bodies, { ...OK_MESSAGE, usage: { input_tokens: 7, output_tokens: 3 } }); expect((await collect(provider.streamChat(cacheRequest()))).find((event) => event.type === "usage")).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
    injectMockStream(provider, bodies, OK_MESSAGE);
    await collect(provider.streamChat(request({ temperature: 0.7, topP: 0.9 }))); expect(bodies[2]).toMatchObject({ temperature: 0.7, top_p: 0.9 });
    await collect(provider.streamChat(request())); expect(bodies[3]).not.toHaveProperty("temperature"); expect(bodies[3]).not.toHaveProperty("top_p");
  });
});

describe("AnthropicProvider 工具配对修复", () => {
  it("悬空 tool_use 补占位 tool_result、游离 tool_result 丢弃，随 tool 消息到达的结果保留", async () => {
    const { provider, bodies } = mockProvider();
    await collect(provider.streamChat(request({ messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: at(0) },
      { id: "a1", role: "assistant", createdAt: at(1), content: [{ type: "tool_call", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }] },
      // !shell 直写的 tool_result：无对应 assistant tool_use（shell-* id），原样发送会 400 unexpected tool_use_id
      { id: "t1", role: "tool", createdAt: at(2), content: [{ type: "tool_result", toolCallId: "shell-abc12345", content: "orphan", isError: false }] },
    ] })));
    expect(bodies[0]!.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "继续" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_dangling", content: expect.stringContaining("interrupted") }] },
    ]);
    await collect(provider.streamChat(request({ messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "查" }], createdAt: at(0) },
      { id: "a1", role: "assistant", createdAt: at(1), content: [{ type: "text", text: "我查一下" }, { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a" } }, { type: "tool_call", id: "call_2", name: "bash", input: { cmd: "ls" } }] },
      { id: "t1", role: "tool", createdAt: at(2), content: [{ type: "tool_result", toolCallId: "call_1", content: "A", isError: false }, { type: "tool_result", toolCallId: "call_2", content: "B", isError: true }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "继续" }], createdAt: at(3) },
      // 中断：结果未落盘，历史以悬空 tool_use 结尾 → 同样补占位收尾
      { id: "a2", role: "assistant", createdAt: at(4), content: [{ type: "tool_call", id: "call_3", name: "bash", input: { cmd: "pwd" } }] },
    ] })));
    const mapped = bodies[1]!.messages as Array<Record<string, unknown>>; expect(mapped).toHaveLength(6); expect(mapped[0]).toEqual({ role: "user", content: [{ type: "text", text: "查" }] });
    expect(mapped[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "我查一下" }, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }, { type: "tool_use", id: "call_2", name: "bash", input: { cmd: "ls" } }] });
    expect(mapped[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "A" }, { type: "tool_result", tool_use_id: "call_2", content: "B", is_error: true }] });
    expect(mapped[3]).toEqual({ role: "user", content: [{ type: "text", text: "继续" }] }); expect(mapped[4]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "call_3", name: "bash", input: { cmd: "pwd" } }] });
    expect(mapped[5]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_3", content: expect.stringContaining("interrupted") }] });
  });
});

describe("ConcurrencyLimitedProvider", () => {
  const dummyRequest: StreamChatRequest = { model: "test", system: "", messages: [], tools: [], signal: new AbortController().signal };
  it("上限内并行、超出 FIFO、错误释放槽位", async () => {
    let current = 0;
    let peak = 0;
    const limited = new ConcurrencyLimitedProvider({ name: "test", async *streamChat() {
      peak = Math.max(peak, ++current);
      try { yield doneEvent; await delay(10); } finally { current--; }
    } }, 2);
    await Promise.all(Array.from({ length: 5 }, () => collect(limited.streamChat(dummyRequest)))); expect(peak).toBe(2);
    const callOrder: number[] = [];
    const fifo = new ConcurrencyLimitedProvider({ name: "test", async *streamChat() {
      callOrder.push(callOrder.length);
      await delay(5);
      yield doneEvent;
    } }, 1);
    await Promise.all(Array.from({ length: 3 }, () => collect(fifo.streamChat(dummyRequest)))); expect(callOrder).toEqual([0, 1, 2]);
    let calls = 0;
    const errorLimited = new ConcurrencyLimitedProvider({ name: "test", async *streamChat(): AsyncIterable<ProviderEvent> { calls++; throw new Error("boom"); } }, 1);
    await expect(collect(errorLimited.streamChat(dummyRequest))).rejects.toThrow("boom");
    await expect(collect(errorLimited.streamChat(dummyRequest))).rejects.toThrow("boom"); expect(calls).toBe(2);
  });

  it("stats 反映 active/queued 并在收尾归零；排队中中止立即出队并拒绝", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const limited = new ConcurrencyLimitedProvider({ name: "test", async *streamChat() { await gate; yield doneEvent; } }, 1); expect(limited.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 1 });
    const first = collect(limited.streamChat(dummyRequest));
    await vi.waitFor(() => expect(limited.getStats()).toMatchObject({ active: 1, queued: 0 }));
    const controller = new AbortController();
    const queued = collect(limited.streamChat({ ...dummyRequest, signal: controller.signal }));
    await vi.waitFor(() => expect(limited.getStats()).toMatchObject({ active: 1, queued: 1 }));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" }); expect(limited.getStats()).toMatchObject({ active: 1, queued: 0 });
    release();
    await first;
    await vi.waitFor(() => expect(limited.getStats()).toMatchObject({ active: 0, queued: 0 }));
  });

  it("release 为队首 waiter 预占槽位（同步窗口 active 不虚降）；注册包装透明", async () => {
    const limited = new ConcurrencyLimitedProvider({ name: "test", async *streamChat() { yield doneEvent; } }, 1);
    const internals = limited as unknown as { acquire(signal: AbortSignal): Promise<void>; release(): void };
    await internals.acquire(new AbortController().signal);
    const granted = internals.acquire(new AbortController().signal); expect(limited.getStats()).toMatchObject({ active: 1, queued: 1 });
    internals.release();
    // waiter 的 acquire 尚未 resolve：槽位已移交，active 必须仍为 1，否则同步 acquire 会瞬时超限
    expect(limited.getStats().active).toBe(1);
    await granted;
    internals.release(); expect(limited.getStats()).toMatchObject({ active: 0, queued: 0 });
    const registry = new ProviderRegistry();
    registry.register({ name: "plain", async *streamChat() { yield doneEvent; } }); expect(registry.concurrencyStats()).toEqual({}); // 缺省不包装（测试/特殊通道）
    registry.register({ name: "limited", promptCaching: true, async *streamChat() { yield doneEvent; } }, DEFAULT_MAX_CONCURRENT); expect(registry.concurrencyStats()["limited"]).toEqual({ active: 0, queued: 0, maxConcurrent: 3 });
    expect([registry.get("limited")?.name, registry.get("limited")?.promptCaching]).toEqual(["limited", true]); // 包装透明
  });
});

describe("collectProviderTurn", () => {
  const retryRequest = (signal: AbortSignal): StreamChatRequest => ({ model: "test", system: "", messages: [], tools: [], signal });

  it("可重试错误按 maxAttempts 重试后成功；不可重试错误立即抛出", async () => {
    let attempts = 0;
    const flaky: Provider = { name: "flaky", async *streamChat() {
      if (++attempts === 1) throw new ProviderError("overloaded", "boom", true);
      yield { type: "text_delta", text: "ok" };
      yield doneEvent;
    } };
    const signal = new AbortController().signal;
    const turn = await collectProviderTurn(flaky, retryRequest(signal), { baseDelayMs: 1 }); expect(attempts).toBe(2); expect(turn.events.at(-1)).toEqual(doneEvent);
    let immediate = 0;
    const nonRetryable: Provider = { name: "deterministic", async *streamChat(): AsyncIterable<ProviderEvent> { immediate++; throw new ProviderError("invalid_request", "bad args", false); } };
    await expect(collectProviderTurn(nonRetryable, retryRequest(signal), { baseDelayMs: 1 })).rejects.toMatchObject({ kind: "invalid_request", retryable: false }); expect(immediate).toBe(1);
  });

  it("done.stopReason=error（静默截断）按可重试失败处理；退避等待前检查 signal", async () => {
    let attempts = 0;
    const retried: number[] = [];
    const truncated: Provider = { name: "truncated-eof", async *streamChat() {
      attempts++;
      yield { type: "text_delta", text: "半截回答" };
      yield { type: "done", stopReason: "error" };
    } };
    const onRetry = ({ attempt }: { attempt: number }) => retried.push(attempt);
    const failure = await collectProviderTurn(truncated, retryRequest(new AbortController().signal), { maxAttempts: 3, baseDelayMs: 1, onRetry }).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ kind: "stream_interrupted", retryable: true }); expect(String((failure as Error).message)).toMatch(/stopReason=error/); expect([attempts, retried]).toEqual([3, [1, 2]]);
    // 重试后拿到正常终态：返回该轮事件（截断轮的事件被丢弃）
    let recovered = 0;
    const flaky: Provider = { name: "truncated-then-ok", async *streamChat() {
      recovered++;
      yield { type: "text_delta", text: "ok" };
      yield recovered === 1 ? { type: "done", stopReason: "error" } : doneEvent;
    } };
    const turn = await collectProviderTurn(flaky, retryRequest(new AbortController().signal), { maxAttempts: 2, baseDelayMs: 1 }); expect([recovered, turn.events.at(-1)]).toEqual([2, doneEvent]);
    // 首次失败进入退避前中止：abortableDelay 开头 throwIfAborted，不再等满 30s
    const controller = new AbortController();
    const startedAt = Date.now();
    const alwaysFailing: Provider = { name: "always-failing", async *streamChat(): AsyncIterable<ProviderEvent> { throw new ProviderError("overloaded", "boom", true); } };
    const abortOnRetry = () => controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(collectProviderTurn(alwaysFailing, retryRequest(controller.signal), { maxAttempts: 3, baseDelayMs: 30_000, onRetry: abortOnRetry })).rejects.toMatchObject({ name: "AbortError" }); expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const userWithImage = (text: string): ChatMessage => ({ id: "u1", role: "user", content: [{ type: "image", mediaType: "image/png", data: PNG }, { type: "text", text }], createdAt: at(0) });
const mmRequest = (messages: ChatMessage[]): StreamChatRequest => ({ model: "claude-haiku-4-5", system: "s", messages, tools: [], signal: new AbortController().signal });

describe("provider image mapping 与预算", () => {
  it("图片块映射（anthropic base64 source / OpenAI image_url parts / 纯文本字符串）与上下文预算裁剪", async () => {
    const { provider, bodies } = mockProvider();
    await collect(provider.streamChat(mmRequest([userWithImage("这是什么")])));
    const anth = (bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!; expect(anth.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
    expect(anth.content[1]).toMatchObject({ type: "text", text: "这是什么" });
    const compatBodies: Array<Record<string, unknown>> = [];
    const compat = new OpenAICompatibleProvider({
      baseURL: "https://example.invalid/v1",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        compatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await collect(compat.streamChat(mmRequest([userWithImage("看图")])));
    const parts = (compatBodies[0]!.messages as Array<Record<string, unknown>>)[1]!.content as Array<Record<string, unknown>>; expect(parts[0]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
    expect(parts[1]).toMatchObject({ type: "text", text: "看图" });
    await collect(compat.streamChat(mmRequest([{ id: "u2", role: "user", content: [{ type: "text", text: "纯文本" }], createdAt: at(1) }]))); expect((compatBodies[1]!.messages as Array<Record<string, unknown>>)[1]!.content).toBe("纯文本");
    // 图片按固定配额估算（与 base64 长度无关）；超预算时最老图片被占位替换，原消息不受影响
    const tokens = estimateMessageTokens([{ id: "u", role: "user", content: [{ type: "image", mediaType: "image/png", data: "A".repeat(400_000) }], createdAt: "x" }]); expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(2_000);
    const messages: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}`, role: "user", content: [{ type: "image", mediaType: "image/png", data: PNG }, { type: "text", text: `第 ${index} 张` }], createdAt: at(index) }));
    const view = await new ContextManager(await tempRoot("owc-mm-")).buildView(messages); expect(view.messages.map((message) => message.content.filter((block) => block.type === "image").length)).toEqual([0, 0, 1, 1, 1, 1]); // 预算 4 张
    expect(view.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("image omitted") }); expect(messages[0]!.content[0]).toMatchObject({ type: "image" });
  });
});

describe("messages route with images", () => {
  it("校验图片与模态支持；vision-tools 扩展启用并配置视觉模型后纯文本主模型放行", { timeout: 60_000 }, async () => {
    const core = { on() { return core; }, configureSession: async () => ({ sandboxCapability: "advisory" }) } as unknown as CoreClient;
    const { root, sessions, agent, events, providers, pricing } = await makeTestApp({
      tempPrefix: "owc-mm-",
      agent: "real",
      core,
      configureProviders: (registry) => registry.register(makeStubProvider("text-stub", async function* () { yield doneEvent; })),
    });
    const deps = { core, sessions, agent, events, providers, pricing };
    const app = await buildServer(deps);
    const extensions = new ExtensionManager(path.join(root, "data"), events, { sessions, providers });
    await extensions.initialize();
    await extensions.configure("vision-tools", { enabled: true, config: { model: "text-stub/qwen-vl-plus" } });
    const visionApp = await buildServer({ ...deps, extensions });
    const post = (target: typeof app, id: string, payload: Record<string, unknown>) => target.inject({ method: "POST", url: `/api/sessions/${id}/messages`, payload });
    const storedImage = async (id: string) => { for (let i = 0; i < 40; i += 1) { const detail = await sessions.get(id); if (detail?.messages.length) return detail.messages[0]?.content[0]; await delay(250); } };
    const settle = async (id: string) => { for (let i = 0; i < 60 && agent.isRunning(id); i += 1) await delay(250); expect(agent.isRunning(id)).toBe(false); }; // 等后台 run 释放会话文件
    try {
      const textOnly = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型" });
      const rejected = await post(app, textOnly.id, { content: "看图", images: [{ mediaType: "image/png", data: PNG }] }); expect(rejected.statusCode).toBe(400); expect(rejected.json<{ error: string }>().error).toContain("不支持图片");
      const capable = await sessions.create({ cwd: root, provider: "text-stub", model: "qwen-vl-plus", title: "带图模型" }); expect((await post(app, capable.id, { content: "看图", images: [{ mediaType: "image/png", data: PNG }] })).statusCode).toBe(202);
      expect(await storedImage(capable.id)).toMatchObject({ type: "image", mediaType: "image/png", data: PNG }); expect((await post(app, capable.id, { content: "x", images: [{ mediaType: "image/tiff", data: PNG }] })).statusCode).toBe(400);
      expect((await post(app, capable.id, { content: "x", images: Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: PNG })) })).statusCode).toBe(400);
      // 主模型纯文本但视觉工具扩展已启用并配置视觉模型：放行（未启用时仍 400，见上）
      const bridged = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型 2" }); expect((await post(visionApp, bridged.id, { content: "看图", images: [{ mediaType: "image/png", data: PNG }] })).statusCode).toBe(202);
      expect(await storedImage(bridged.id)).toMatchObject({ type: "image", mediaType: "image/png", data: PNG });
      await settle(capable.id);
      await settle(bridged.id);
    } finally {
      await extensions.close();
      await visionApp.close();
      await app.close();
    }
  });
});
