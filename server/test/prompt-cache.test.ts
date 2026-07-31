import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import type { StreamChatRequest } from "../src/providers/provider.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text }] };
}

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "claude-opus-4-8", system: "stable system prefix", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

const TOOLS = [
  { name: "read", description: "Read a file", inputSchema: { type: "object" } },
  { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
];

/** 默认 finalMessage：文本 "ok" + 基础 usage；cache 字段经 usage 覆盖注入。 */
const OK_MESSAGE = { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] };

async function collect(iterable: AsyncIterable<{ type: string }>): Promise<Array<{ type: string }>> {
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
    await collect(provider.streamChat(request({
      systemSuffix: "background task finished",
      tools: TOOLS,
      messages: [message("u1", "user", "first"), message("u2", "user", "second")],
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
    await collect(provider.streamChat(request({
      tools: TOOLS,
      messages: ["m1", "m2", "m3", "m4"].map((id) => message(id, "user", id)),
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
    const history = [message("u1", "user", "first"), message("a1", "assistant", "reply")];
    const turn1 = request({
      systemSuffix: "notice one",
      tools: TOOLS,
      messages: history,
      cacheBreakpoints: ["u1"],
    });
    const turn2 = request({
      systemSuffix: "notice two",
      tools: TOOLS,
      messages: [...history, message("u2", "user", "follow up")],
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
      const provider = new AnthropicProvider(init);
      const bodies: Array<Record<string, unknown>> = [];
      injectMockStream(provider, bodies, OK_MESSAGE);
      await collect(provider.streamChat(request({
        ...(init.promptCaching === false ? {} : { promptCaching: false }),
        systemSuffix: "tail",
        tools: TOOLS,
        messages: [message("u1", "user", "hi")],
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
    const events = await collect(provider.streamChat(request()));
    const usage = events.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number; inputTokens: number };
    expect(usage).toMatchObject({ inputTokens: 100, cacheRead: 800, cacheWrite: 1500 });

    injectMockStream(provider, bodies, { ...OK_MESSAGE, usage: { input_tokens: 7, output_tokens: 3 } });
    const legacy = await collect(provider.streamChat(request()));
    const legacyUsage = legacy.find((event) => event.type === "usage") as unknown as { cacheRead: number; cacheWrite: number };
    expect(legacyUsage).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
  });
});
