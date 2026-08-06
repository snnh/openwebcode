import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/providers/provider-error.js";
import type { Provider, StreamChatRequest } from "../src/providers/provider.js";
import { collectProviderTurn } from "../src/providers/retry.js";

function request(signal: AbortSignal): StreamChatRequest {
  return { model: "test", system: "", messages: [], tools: [], signal };
}

describe("collectProviderTurn", () => {
  it("可重试错误按 maxAttempts 重试后成功", async () => {
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
    const turn = await collectProviderTurn(provider, request(new AbortController().signal), { baseDelayMs: 1 });
    expect(attempts).toBe(2);
    expect(turn.events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
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
    await expect(collectProviderTurn(provider, request(controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 30_000,
      onRetry: () => controller.abort(new DOMException("cancelled", "AbortError")),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("不可重试错误立即抛出", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: "deterministic",
      async *streamChat() {
        attempts += 1;
        throw new ProviderError("invalid_request", "bad args", false);
      },
    };
    await expect(collectProviderTurn(provider, request(new AbortController().signal), { baseDelayMs: 1 }))
      .rejects.toMatchObject({ kind: "invalid_request", retryable: false });
    expect(attempts).toBe(1);
  });
});
