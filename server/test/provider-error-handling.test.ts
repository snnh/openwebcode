import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, MAX_SSE_EVENT_BYTES, readSseData } from "../src/providers/openai-compatible-provider.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";

/**
 * provider 错误处理回归：
 * - 错误体截断后进错误消息（错误消息会经 agent-runner 广播进 WS 事件流）
 * - SSE 单事件字节上限（不可重试）
 * - 流尾无空行终止的残留 buffer 仍按最后一个事件解析
 * - 工具参数 JSON 解析失败归不可重试（流截断属确定性错误）
 * - Responses response.failed/error 按 failure code 区分可重试
 */

function request(): StreamChatRequest {
  return { model: "test-model", system: "system", messages: [], tools: [], signal: new AbortController().signal };
}

const encoder = new TextEncoder();
const chunk = (text: string): Uint8Array => encoder.encode(text);

function fetchWith(body: string, status = 200): typeof globalThis.fetch {
  const contentType = status === 200 ? "text/event-stream" : "application/json";
  return (async () => new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof globalThis.fetch;
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
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

describe("provider 错误体截断", () => {
  it("openai-compatible：超限错误体截断为 2000 字符 + …", async () => {
    const detail = `{"error":"${"x".repeat(5000)}"}`;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(detail, 500) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(2_100);
    expect(error.message).not.toContain(detail.slice(-20));
  });

  it("openai-responses：超限错误体同样截断，两家口径一致", async () => {
    const detail = `{"error":"${"y".repeat(5000)}"}`;
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(detail, 400) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(2_100);
  });

  it("未超限的错误体原样保留", async () => {
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith("short detail", 500) });
    const error = await expectProviderError(provider.streamChat(request()));
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
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(body) });
    const events = await collect(provider.streamChat(request()));
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
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(body) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
  });

  it("openai-responses：function_call 参数截断 → invalid_request（不可重试）", async () => {
    const body = [
      { type: "response.output_item.done", item_id: "fc_1", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":" } },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(body) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.kind).toBe("invalid_request");
    expect(error.retryable).toBe(false);
  });
});

describe("Responses response.failed/error 按 failure code 区分可重试", () => {
  function failedBody(event: Record<string, unknown>): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  it("server_error → 可重试（overloaded）", async () => {
    const body = failedBody({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } });
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(body) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.kind).toBe("overloaded");
    expect(error.retryable).toBe(true);
  });

  it("error 事件的 rate_limit → 可重试（rate_limit）", async () => {
    const body = failedBody({ type: "error", code: "rate_limit", message: "slow down" });
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: fetchWith(body) });
    const error = await expectProviderError(provider.streamChat(request()));
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
  });

  it("无 code / 确定性 code → 不可重试", async () => {
    const invalid = new OpenAIResponsesProvider({
      baseURL: "https://example.invalid/v1",
      fetch: fetchWith(failedBody({ type: "response.failed", response: { status: "failed", error: { code: "invalid_request", message: "bad" } } })),
    });
    expect((await expectProviderError(invalid.streamChat(request()))).retryable).toBe(false);

    const noCode = new OpenAIResponsesProvider({
      baseURL: "https://example.invalid/v1",
      fetch: fetchWith(failedBody({ type: "response.failed", response: { status: "failed", error: { message: "bad" } } })),
    });
    expect((await expectProviderError(noCode.streamChat(request()))).retryable).toBe(false);
  });
});
