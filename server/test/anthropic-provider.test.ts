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

async function cacheCollect(iterable: AsyncIterable<{ type: string }>): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of iterable) events.push(event);
  return events;
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
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies, OK_MESSAGE);
    await cacheCollect(provider.streamChat(cacheRequest({
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
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies, OK_MESSAGE);
    await cacheCollect(provider.streamChat(cacheRequest({
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
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies, OK_MESSAGE);
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
    await cacheCollect(provider.streamChat(turn1));
    await cacheCollect(provider.streamChat(turn2));
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
      const provider = new AnthropicProvider(init);
      const bodies: Array<Record<string, unknown>> = [];
      injectMockStream(provider, bodies, OK_MESSAGE);
      await cacheCollect(provider.streamChat(cacheRequest({
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
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    injectMockStream(provider, bodies, {
      ...OK_MESSAGE,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 1500,
      },
    });
    const events = await cacheCollect(provider.streamChat(cacheRequest()));
    const usage = events.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number; inputTokens: number };
    expect(usage).toMatchObject({ inputTokens: 100, cacheRead: 800, cacheWrite: 1500 });

    injectMockStream(provider, bodies, { ...OK_MESSAGE, usage: { input_tokens: 7, output_tokens: 3 } });
    const legacy = await cacheCollect(provider.streamChat(cacheRequest()));
    const legacyUsage = legacy.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number };
    expect(legacyUsage).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
  });
});