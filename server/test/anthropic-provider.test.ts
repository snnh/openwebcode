import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { ContextManager } from "../src/context/context-manager.js";
import { estimateMessageTokens, IMAGE_TOKEN_ESTIMATE } from "../src/context/model-profile.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { ConcurrencyLimitedProvider, DEFAULT_MAX_CONCURRENT } from "../src/providers/concurrency-limiter.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { collectProviderTurn } from "../src/providers/retry.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("AnthropicProvider 消息映射边界", () => {
  it("只含异源 thinking 块的 assistant 消息补占位 text（空 content 会 400）", async () => {
    const { provider, bodies } = mockProvider();
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
    const { provider, bodies } = mockProvider({
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

  it("未声明 thinkingStyle 时按模型名推断：4.5 及以前 extended，4.6+/未知 adaptive", async () => {
    // 新旧两代命名 + 8 位日期后缀不得被读成次版本（读成 20250514 会误判 adaptive → 400）
    const cases: Array<[string, "enabled" | "adaptive"]> = [
      ["claude-3-5-sonnet-20241022", "enabled"],
      ["claude-3-7-sonnet-20250219", "enabled"],
      ["claude-3-opus-20240229", "enabled"],
      ["claude-sonnet-4-20250514", "enabled"],
      ["claude-opus-4-1-20250805", "enabled"],
      ["claude-sonnet-4-5-20250929", "enabled"],
      ["claude-opus-4-6", "adaptive"],
      ["claude-sonnet-5", "adaptive"],
      ["deepseek-reasoner", "adaptive"],
    ];
    const { provider, bodies } = mockProvider();
    for (const [model] of cases) {
      await collect(provider.streamChat(request({ model, thinking: "enabled" })));
    }
    expect(bodies.map((body) => (body.thinking as { type: string }).type)).toEqual(cases.map(([, type]) => type));
    // extended 形态必须带预算，adaptive 形态不得带（该代已弃用 budget_tokens）
    expect(bodies[0]!.thinking).toMatchObject({ type: "enabled", budget_tokens: expect.any(Number) });
    expect(bodies[6]!.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

// ---- prompt-cache 组（合并） ----
function cacheMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text }] };
}

function cacheRequest(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "stable system prefix", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

const CACHE_TOOLS = [
  { name: "read", description: "Read a file", inputSchema: { type: "object" } },
  { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
];

/** 默认 finalMessage：文本 "ok" + 基础 usage；cache 字段经 usage 覆盖注入。 */
const OK_MESSAGE = { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] };

/** 构造带捕获式 mock stream 的 provider：请求体进 bodies；options 注入 finalMessage（content/usage/stopReason）。 */
function mockProvider(
  options: Parameters<typeof injectMockStream>[2] = {},
  init: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey: "test" },
): { provider: AnthropicProvider; bodies: Array<Record<string, unknown>> } {
  const provider = new AnthropicProvider(init);
  const bodies: Array<Record<string, unknown>> = [];
  injectMockStream(provider, bodies, options);
  return { provider, bodies };
}

/** 递归统计 cache_control 断点数（只数 system/tools/messages，兼容网关的顶层 cache_control 不计入 API 上限）。 */
function countBreakpoints(...roots: unknown[]): number {
  const walk = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + walk(item), 0);
    if (!value || typeof value !== "object") return 0;
    const record = value as Record<string, unknown>;
    return (record.cache_control ? 1 : 0) + Object.values(record).reduce((sum, item) => sum + walk(item), 0);
  };
  return roots.reduce((sum, root) => sum + walk(root), 0);
}

/** body 内计入 Anthropic 断点上限（≤4）的位置：system、tools、messages。 */
function apiBreakpoints(body: Record<string, unknown>): number {
  return countBreakpoints(body.system, body.tools, body.messages);
}

describe("Anthropic prompt cache 断点", () => {
  it("在 system 稳定块、末位工具与消息前缀上打断点，动态尾部不打", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    await collect(provider.streamChat(cacheRequest({
      systemSuffix: "background task finished",
      tools: CACHE_TOOLS,
      messages: [cacheMessage("u1", "user", "first"), cacheMessage("u2", "user", "second")],
      cacheBreakpoints: ["u1"],
    })));

    const body = bodies[0]!;
    // system：稳定块带断点，动态尾部独立成块且不带断点
    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]).toMatchObject({ text: "stable system prefix", cache_control: { type: "ephemeral" } });
    expect(system[1]).toMatchObject({ text: "background task finished" });
    expect(system[1]).not.toHaveProperty("cache_control");
    // tools：仅末位工具带断点
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    // messages：u1 末块带断点，u2 不带
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]!.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(messages[1]!.content.at(-1)).not.toHaveProperty("cache_control");
    // 总断点数 = system 1 + tools 1 + messages 1 = 3 ≤ 4
    expect(apiBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  it("消息级断点超出预算时按 ≤4 总额截断（保留最前者）", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    await collect(provider.streamChat(cacheRequest({
      tools: CACHE_TOOLS,
      messages: ["m1", "m2", "m3", "m4"].map((id) => cacheMessage(id, "user", id)),
      cacheBreakpoints: ["m1", "m2", "m3", "m4"],
    })));
    const body = bodies[0]!;
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const marked = messages.filter((item) => item.content.at(-1)!.cache_control);
    // system 1 + tools 1，消息预算 = 2
    expect(marked).toHaveLength(2);
    expect(apiBreakpoints(body)).toBe(4);
  });

  it("连续两 turn 稳定前缀逐字节一致，只有尾部变化", async () => {
    const { provider, bodies } = mockProvider(OK_MESSAGE);
    const history = [cacheMessage("u1", "user", "first"), cacheMessage("a1", "assistant", "reply")];
    const turn1 = cacheRequest({
      systemSuffix: "notice one",
      tools: CACHE_TOOLS,
      messages: history,
      cacheBreakpoints: ["u1"],
    });
    const turn2 = cacheRequest({
      systemSuffix: "notice two",
      tools: CACHE_TOOLS,
      messages: [...history, cacheMessage("u2", "user", "follow up")],
      cacheBreakpoints: ["u1"],
    });
    await collect(provider.streamChat(turn1));
    await collect(provider.streamChat(turn2));
    const [first, second] = bodies as Array<Record<string, unknown>>;
    // 稳定系统块与工具定义逐字节一致
    expect(JSON.stringify((second.system as unknown[])[0])).toBe(JSON.stringify((first.system as unknown[])[0]));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    // 消息前缀（断点之前的部分）逐字节一致
    const firstMessages = first.messages as unknown[];
    const secondMessages = second.messages as unknown[];
    expect(JSON.stringify(secondMessages.slice(0, firstMessages.length))).toBe(JSON.stringify(firstMessages));
  });

  it("provider 级或请求级关闭后不打任何断点，system 退化为字符串", async () => {
    for (const init of [{ apiKey: "test", promptCaching: false }, { apiKey: "test" }] as const) {
      const { provider, bodies } = mockProvider(OK_MESSAGE, init);
      await collect(provider.streamChat(cacheRequest({
        ...(init.promptCaching === false ? {} : { promptCaching: false }),
        systemSuffix: "tail",
        tools: CACHE_TOOLS,
        messages: [cacheMessage("u1", "user", "hi")],
        cacheBreakpoints: ["u1"],
      })));
      const body = bodies[0]!;
      expect(apiBreakpoints(body)).toBe(0);
      expect(typeof body.system).toBe("string");
      expect(body.system).toBe("stable system prefix\n\ntail");
    }
  });

  it("usage 映射 cache 读写字段；旧响应缺失字段按 0 处理", async () => {
    const { provider, bodies } = mockProvider({
      ...OK_MESSAGE,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 1500,
      },
    });
    const events = await collect(provider.streamChat(cacheRequest()));
    const usage = events.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number; inputTokens: number };
    expect(usage).toMatchObject({ inputTokens: 100, cacheRead: 800, cacheWrite: 1500 });

    injectMockStream(provider, bodies, { ...OK_MESSAGE, usage: { input_tokens: 7, output_tokens: 3 } });
    const legacy = await collect(provider.streamChat(cacheRequest()));
    const legacyUsage = legacy.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number };
    expect(legacyUsage).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
  });

  it("请求级 temperature/topP 映射为 temperature/top_p；未下发时不携带", async () => {
    const { provider, bodies } = mockProvider();
    await collect(provider.streamChat(request({ temperature: 0.7, topP: 0.9 })));
    expect(bodies[0]).toMatchObject({ temperature: 0.7, top_p: 0.9 });

    await collect(provider.streamChat(request()));
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("top_p");
  });
});
describe("AnthropicProvider 工具配对修复", () => {
  it("悬空 tool_use 补占位 tool_result，游离 tool_result 丢弃", async () => {
    const { provider, bodies } = mockProvider();
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [{ type: "tool_call", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }],
      },
      // !shell 直写的 tool_result：无对应 assistant tool_use（shell-* id），原样发送会 400 unexpected tool_use_id
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "shell-abc12345", content: "orphan", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    await collect(provider.streamChat(request({ messages })));

    expect(bodies[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "继续" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_dangling", name: "bash", input: { cmd: "sleep 600" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_dangling", content: expect.stringContaining("interrupted") }] },
    ]);
  });

  it("tool_result 随 tool 消息到达时保留；历史以悬空 tool_use 结尾时补占位收尾", async () => {
    const { provider, bodies } = mockProvider();
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "查" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a" } },
          { type: "tool_call", id: "call_2", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        id: "t1", role: "tool", createdAt: "2026-01-01T00:00:02.000Z",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "A", isError: false },
          { type: "tool_result", toolCallId: "call_2", content: "B", isError: true },
        ],
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:03.000Z" },
      // 中断：结果未落盘，历史以悬空 tool_use 结尾
      { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:04.000Z", content: [{ type: "tool_call", id: "call_3", name: "bash", input: { cmd: "pwd" } }] },
    ];
    await collect(provider.streamChat(request({ messages })));

    expect(bodies[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "查" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "call_2", name: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "A" },
          { type: "tool_result", tool_use_id: "call_2", content: "B", is_error: true },
        ],
      },
      { role: "user", content: [{ type: "text", text: "继续" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_3", name: "bash", input: { cmd: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_3", content: expect.stringContaining("interrupted") }] },
    ]);
  });
});

/** A fake provider that yields events and tracks concurrent calls */
function fakeProvider(name: string): { provider: Provider; getCurrentConcurrent: () => number; getMaxConcurrent: () => number } {
  let current = 0;
  let max = 0;
  const provider: Provider = {
    name,
    async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
      current++;
      max = Math.max(max, current);
      try {
        yield { type: "text_delta", text: "hello" };
        // Small delay to simulate work
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "done", stopReason: "end_turn" };
      } finally {
        current--;
      }
    },
  };
  return { provider, getCurrentConcurrent: () => current, getMaxConcurrent: () => max };
}

const dummyRequest: StreamChatRequest = {
  model: "test",
  system: "",
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

describe("ConcurrencyLimitedProvider (0.5.0 Phase 2)", () => {
  it("并发包装三保证：上限内并行、超出 FIFO、错误释放槽位", async () => {
    // 同时运行不超过 maxConcurrent
    const { provider, getMaxConcurrent } = fakeProvider("test");
    const limited = new ConcurrencyLimitedProvider(provider, 2);
    const promises = Array.from({ length: 5 }, () => {
      const events: ProviderEvent[] = [];
      return (async () => {
        for await (const event of limited.streamChat(dummyRequest)) events.push(event);
        return events;
      })();
    });
    await Promise.all(promises);
    // At most 2 should have been running simultaneously
    expect(getMaxConcurrent()).toBe(2);

    // 超出部分排队并按 FIFO 顺序执行
    const callOrder: number[] = [];
    let counter = 0;
    const fifoProvider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        const id = counter++;
        callOrder.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const fifoLimited = new ConcurrencyLimitedProvider(fifoProvider, 1);
    await Promise.all([
      (async () => { for await (const _ of fifoLimited.streamChat(dummyRequest)) {} })(),
      (async () => { for await (const _ of fifoLimited.streamChat(dummyRequest)) {} })(),
      (async () => { for await (const _ of fifoLimited.streamChat(dummyRequest)) {} })(),
    ]);
    expect(callOrder).toEqual([0, 1, 2]);

    // 错误路径释放槽位：第二次调用照常执行
    let callCount = 0;
    const throwingProvider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        callCount++;
        throw new Error("boom");
      },
    };
    const errorLimited = new ConcurrencyLimitedProvider(throwingProvider, 1);
    await expect(async () => {
      for await (const _ of errorLimited.streamChat(dummyRequest)) {}
    }).rejects.toThrow("boom");
    await expect(async () => {
      for await (const _ of errorLimited.streamChat(dummyRequest)) {}
    }).rejects.toThrow("boom");
    expect(callCount).toBe(2);
  });

  it("removes and rejects a queued request immediately when it is aborted", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider: Provider = {
      name: "test",
      async *streamChat(): AsyncIterable<ProviderEvent> {
        await gate;
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 1);
    const first = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    await vi.waitFor(() => expect(limited.getStats().active).toBe(1));

    const controller = new AbortController();
    const queued = (async () => {
      for await (const _ of limited.streamChat({ ...dummyRequest, signal: controller.signal })) {}
    })();
    await vi.waitFor(() => expect(limited.getStats().queued).toBe(1));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(limited.getStats()).toMatchObject({ active: 1, queued: 0 });

    releaseFirst();
    await first;
  });

  it("exposes correct stats", async () => {
    // Use a provider with a controlled gate: each call blocks until a shared counter is incremented
    let gate = 0;
    const gates: Array<() => void> = [];
    const provider: Provider = {
      name: "test",
      async *streamChat(_request: StreamChatRequest): AsyncIterable<ProviderEvent> {
        // Block until gate is opened
        if (gate === 0) await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const limited = new ConcurrencyLimitedProvider(provider, 2);

    expect(limited.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });

    // Start two requests — both should acquire slots and block on the gate
    const p1 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    const p2 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limited.getStats().active).toBe(2);
    expect(limited.getStats().queued).toBe(0);

    // Start third — should be queued
    const p3 = (async () => { for await (const _ of limited.streamChat(dummyRequest)) {} })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limited.getStats()).toMatchObject({ active: 2, queued: 1 });

    // Open the gate — first request completes, third starts and also blocks
    gate = 1;
    gates.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));

    // All should complete now
    await Promise.all([p1, p2, p3]);
    expect(limited.getStats().active).toBe(0);
    expect(limited.getStats().queued).toBe(0);
  });

  it("release 为队首 waiter 预占槽位：grant 与 waiter 续跑之间 active 不虚降", async () => {
    const { provider } = fakeProvider("test");
    const limited = new ConcurrencyLimitedProvider(provider, 1);
    // 白盒驱动 acquire/release，停在 grant 已发生、waiter 尚未续跑的同步窗口
    const internals = limited as unknown as {
      acquire(signal: AbortSignal): Promise<void>;
      release(): void;
    };
    await internals.acquire(new AbortController().signal);
    const granted = internals.acquire(new AbortController().signal);
    expect(limited.getStats()).toMatchObject({ active: 1, queued: 1 });

    internals.release();
    // 同步窗口内（waiter 的 acquire 尚未 resolve）：槽位已移交，active 必须仍为 1，
    // 否则此刻的同步 acquire 会看到虚低 active 而瞬时超限
    expect(limited.getStats().active).toBe(1);
    await granted;
    expect(limited.getStats().active).toBe(1);

    internals.release();
    expect(limited.getStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("注册包装透明：缺省不限流、显式 DEFAULT_MAX_CONCURRENT 按 3 限流；代理 name/promptCaching", () => {
    const registry = new ProviderRegistry();
    const plain = fakeProvider("plain");
    registry.register(plain.provider);
    // 缺省不包装（测试/特殊通道）；生产路径由 provider-profiles-runtime 显式接线
    expect(registry.concurrencyStats()).toEqual({});

    const limited = fakeProvider("limited");
    registry.register(limited.provider, DEFAULT_MAX_CONCURRENT);
    expect(registry.concurrencyStats()["limited"]).toEqual({ active: 0, queued: 0, maxConcurrent: 3 });
    // 包装透明：name 代理到底层 provider
    expect(registry.get("limited")?.name).toBe("limited");

    // 包装器直接代理 name 与 promptCaching
    const proxied: Provider = {
      name: "test-provider",
      promptCaching: true,
      async *streamChat(): AsyncIterable<ProviderEvent> {
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const wrapper = new ConcurrencyLimitedProvider(proxied, 3);
    expect(wrapper.name).toBe("test-provider");
    expect(wrapper.promptCaching).toBe(true);
  });
});

// ---- provider-retry 组（合并） ----
function retryRequest(signal: AbortSignal): StreamChatRequest {
  return { model: "test", system: "", messages: [], tools: [], signal };
}

describe("collectProviderTurn", () => {
  it("可重试错误按 maxAttempts 重试后成功；不可重试错误立即抛出", async () => {
    // 可重试：重试后成功
    let attempts = 0;
    const provider: Provider = {
      name: "flaky",
      async *streamChat() {
        attempts += 1;
        if (attempts === 1) throw new ProviderError("overloaded", "boom", true);
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const turn = await collectProviderTurn(provider, retryRequest(new AbortController().signal), { baseDelayMs: 1 });
    expect(attempts).toBe(2);
    expect(turn.events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    // 不可重试：立即抛出，不重试
    let immediateAttempts = 0;
    const nonRetryable: Provider = {
      name: "deterministic",
      async *streamChat() {
        immediateAttempts += 1;
        throw new ProviderError("invalid_request", "bad args", false);
      },
    };
    await expect(collectProviderTurn(nonRetryable, retryRequest(new AbortController().signal), { baseDelayMs: 1 }))
      .rejects.toMatchObject({ kind: "invalid_request", retryable: false });
    expect(immediateAttempts).toBe(1);
  });

  it("abortableDelay 进入前检查 signal：重试等待期间已中止则立即抛出，不白等", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      name: "always-failing",
      async *streamChat() {
        throw new ProviderError("overloaded", "boom", true);
      },
    };
    const startedAt = Date.now();
    // 首次失败进入退避前中止：abortableDelay 开头 throwIfAborted，不再等满 30s
    await expect(collectProviderTurn(provider, retryRequest(controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 30_000,
      onRetry: () => controller.abort(new DOMException("cancelled", "AbortError")),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function userWithImage(text: string): ChatMessage {
  return {
    id: "u1",
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", data: PNG },
      { type: "text", text },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function mmRequest(messages: ChatMessage[]): StreamChatRequest {
  return { model: "claude-haiku-4-5", system: "s", messages, tools: [], signal: new AbortController().signal };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

describe("provider image mapping", () => {
  it("maps image blocks to Anthropic base64 image blocks", async () => {
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
    await drain(provider.streamChat(mmRequest([userWithImage("这是什么")])));
    const message = (bodies[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[0]!;
    expect(message.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
    expect(message.content[1]).toMatchObject({ type: "text", text: "这是什么" });
  });

  it("maps image blocks to OpenAI image_url parts and keeps string content when text-only", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetch as typeof globalThis.fetch });
    await drain(provider.streamChat(mmRequest([userWithImage("看图")])));
    const withImage = (bodies[0]!.messages as Array<Record<string, unknown>>)[1]!;
    expect(Array.isArray(withImage.content)).toBe(true);
    const parts = withImage.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
    expect(parts[1]).toMatchObject({ type: "text", text: "看图" });

    await drain(provider.streamChat(mmRequest([{ id: "u2", role: "user", content: [{ type: "text", text: "纯文本" }], createdAt: "2026-01-01T00:00:01.000Z" }])));
    const textOnly = (bodies[1]!.messages as Array<Record<string, unknown>>)[1]!;
    expect(textOnly.content).toBe("纯文本");
  });
});

describe("image token estimation and LRU budget", () => {
  it("estimates images at a fixed quota, not base64 length", () => {
    const big = "A".repeat(400_000);
    const tokens = estimateMessageTokens([{ id: "u", role: "user", content: [{ type: "image", mediaType: "image/png", data: big }], createdAt: "x" }]);
    expect(tokens).toBeLessThan(2_000);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
  });

  it("drops older images beyond the budget from the LLM view", async () => {
    const root = await tempRoot("owc-mm-");
    const context = new ContextManager(root);
    const messages: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({
      id: `u${index}`,
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: PNG }, { type: "text", text: `第 ${index} 张` }],
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
    }));
    const view = await context.buildView(messages);
    const images = view.messages.map((message) => message.content.filter((block) => block.type === "image").length);
    // 预算 4 张：最新的 4 条保留图片，更早的被占位文本替换
    expect(images).toEqual([0, 0, 1, 1, 1, 1]);
    expect(view.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("image omitted") });
    // 存储的原始消息不受影响
    expect(messages[0]!.content[0]).toMatchObject({ type: "image" });
  });
});

describe("messages route with images", () => {
  it("validates images and modality support", { timeout: 20_000 }, async () => {
    const root = await tempRoot("owc-mm-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("text-stub", async function* () {
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    try {
      // text-stub 的默认模型档案为纯文本：带图 400
      const textOnly = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型" });
      const rejected = await app.inject({ method: "POST", url: `/api/sessions/${textOnly.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<{ error: string }>().error).toContain("不支持图片");

      // metadata 前缀档案支持图片的模型：接受
      const capable = await sessions.create({ cwd: root, provider: "text-stub", model: "qwen-vl-plus", title: "带图模型" });
      const accepted = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
      expect(accepted.statusCode).toBe(202);
      let stored;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stored = await sessions.get(capable.id);
        if (stored?.messages.length) break;
      }
      expect(stored?.messages[0]?.content[0]).toMatchObject({ type: "image", mediaType: "image/png", data: PNG });

      const badType = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "x", images: [{ mediaType: "image/tiff", data: PNG }] } });
      expect(badType.statusCode).toBe(400);
      const tooMany = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "x", images: Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: PNG })) } });
      expect(tooMany.statusCode).toBe(400);
      // POST /messages only acknowledges the background run.  Wait for it to
      // release the session files before afterEach removes the Windows temp dir.
      for (let attempt = 0; attempt < 60 && agent.isRunning(capable.id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(agent.isRunning(capable.id)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("vision-tools 扩展启用时纯文本主模型允许带图消息", { timeout: 30_000 }, async () => {
    const root = await tempRoot("owc-mm-vision-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("text-stub", async function* () {
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const extensions = new ExtensionManager(path.join(root, "data"), events, { sessions, providers });
    await extensions.initialize();
    await extensions.configure("vision-tools", { enabled: true, config: { model: "text-stub/qwen-vl-plus" } });
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, extensions });
    try {
      // 主模型纯文本，但视觉工具扩展已启用并配置视觉模型：带图消息放行
      const textOnly = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型" });
      const accepted = await app.inject({ method: "POST", url: `/api/sessions/${textOnly.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
      expect(accepted.statusCode).toBe(202);
      let stored;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stored = await sessions.get(textOnly.id);
        if (stored?.messages.length) break;
      }
      expect(stored?.messages[0]?.content[0]).toMatchObject({ type: "image", mediaType: "image/png", data: PNG });

      // 扩展未启用时仍拒绝
      const plain = await buildServer({ core, sessions, agent, events, providers, pricing });
      try {
        const noBridge = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型 2" });
        const rejected = await plain.inject({ method: "POST", url: `/api/sessions/${noBridge.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
        expect(rejected.statusCode).toBe(400);
      } finally {
        await plain.close();
      }

      for (let attempt = 0; attempt < 60 && agent.isRunning(textOnly.id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(agent.isRunning(textOnly.id)).toBe(false);
    } finally {
      await extensions.close();
      await app.close();
    }
  });
});
