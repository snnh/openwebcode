import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { ProviderError } from "../src/providers/provider-error.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";

/**
 * SSE 流 idle 超时：代理/网关半开连接会周期性滴心跳注释（": ping"），
 * 字节持续到达但永无 data 事件——计时只在 data 事件时重置，超时判半开并走重试。
 */

function request(): StreamChatRequest {
  return { model: "test-model", system: "system", messages: [], tools: [], signal: new AbortController().signal };
}

const encoder = new TextEncoder();
const chunk = (text: string): Uint8Array => encoder.encode(text);

function sseResponse(pump: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { pump(controller); } });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const dataEvent = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;

describe("SSE stream idle timeout", () => {
  it("心跳注释续命但无 data 事件：判半开连接，抛 stream_interrupted（可重试）", async () => {
    const fetch = (async () => sseResponse((controller) => {
      controller.enqueue(chunk(dataEvent({ choices: [{ delta: { content: "hi" } }] })));
      const timer = setInterval(() => {
        try { controller.enqueue(chunk(": ping\n\n")); } catch { clearInterval(timer); }
      }, 20);
    })) as unknown as typeof globalThis.fetch;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch, streamIdleTimeoutMs: 100 });

    let caught: unknown;
    try {
      for await (const _ of provider.streamChat(request())) { /* drain */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("stream_interrupted");
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as Error).message).toMatch(/half-open/);
  });

  it("持续产出 data 事件会重置计时：慢速流不被误杀", async () => {
    const fetch = (async () => sseResponse((controller) => {
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        try {
          if (step <= 5) controller.enqueue(chunk(dataEvent({ choices: [{ delta: { content: `t${step}` } }] })));
          else if (step === 6) controller.enqueue(chunk(dataEvent({ choices: [{ delta: {}, finish_reason: "stop" }] })));
          else {
            controller.enqueue(chunk("data: [DONE]\n\n"));
            controller.close();
            clearInterval(timer);
          }
        } catch { clearInterval(timer); }
      }, 40);
    })) as unknown as typeof globalThis.fetch;
    // 间隔 40ms < idle 上限 200ms：流虽慢但持续有 data，不应触发超时
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch, streamIdleTimeoutMs: 200 });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamChat(request())) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(5);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("streamIdleTimeoutMs=0 关闭超时：完全静默的流挂到调用方中止", async () => {
    const fetch = (async (_input: unknown, init?: RequestInit) => sseResponse((controller) => {
      controller.enqueue(chunk(dataEvent({ choices: [{ delta: { content: "hi" } }] })));
      // 真实 fetch 会把 signal 中止传导到响应体；假流这里手动复现
      init?.signal?.addEventListener("abort", () => {
        try { controller.error(new DOMException("The operation was aborted", "AbortError")); } catch { /* 已关闭 */ }
      });
    })) as unknown as typeof globalThis.fetch;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch, streamIdleTimeoutMs: 0 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(async () => {
      for await (const _ of provider.streamChat({ ...request(), signal: controller.signal })) { /* drain */ }
    }).rejects.toThrow();
  });
});
