import { describe, expect, it } from "vitest";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";

describe("FastModelClient", () => {
  it("reuses the selected provider and forwards model request parameters", async () => {
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "thinking_delta", text: "hidden" };
        yield { type: "text_delta", text: "快速" };
        yield { type: "text_delta", text: "回答" };
        yield { type: "usage", inputTokens: 12, outputTokens: 4, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const client = new FastModelClient(providers, {
      provider: "shared-provider",
      model: "fast-1",
      thinking: "enabled",
      effort: "high",
    });

    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 512 })).resolves.toEqual({
      text: "快速回答",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "fast-1",
      thinking: "enabled",
      effort: "high",
      system: "system",
      tools: [],
      maxTokens: 512,
      messages: [{ role: "user", content: [{ type: "text", text: "prompt" }] }],
    });
  });

  it("forwards the caller-required maxTokens without any config cap and reports unavailable providers", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    // 无全局钳制：调用方给多少就透传多少
    await client.complete({ system: "system", prompt: "prompt", maxTokens: 8_192 });
    expect(requests[0]?.maxTokens).toBe(8_192);

    client.setConfig({ provider: "disabled-provider", model: "fast-2" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型服务商不可用");
  });

  it("经 collectProviderTurn 重试：可重试失败第二次成功（maxAttempts=2）", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        if (attempts === 1) throw new ProviderError("overloaded", "瞬时限流", true);
        yield { type: "text_delta", text: "重试成功" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "重试成功" });
    expect(attempts).toBe(2);
  });

  it("不可重试失败不重试", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        throw new ProviderError("authentication", "bad key", false);
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型请求失败");
    expect(attempts).toBe(1);
  });

  it("空 text + max_tokens：翻倍预算重试一次，第二次成功且 usage 合并", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "thinking_delta", text: "推理占满预算" };
          yield { type: "usage", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "max_tokens" };
        } else {
          yield { type: "text_delta", text: "兜底成功" };
          yield { type: "usage", inputTokens: 10, outputTokens: 8, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toEqual({ text: "兜底成功", usage: { inputTokens: 110, outputTokens: 58 } });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.maxTokens).toBe(256);
    expect(requests[1]?.maxTokens).toBe(512);
  });

  it("重试仍空但有 thinking_delta：返回 thinking 文本", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "thinking_delta", text: "思考结论" };
        yield { type: "done", stopReason: "max_tokens" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "思考结论" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.maxTokens).toBe(512);
  });

  it("空 text + end_turn 但有 thinking：不重试，直接返回 thinking", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        yield { type: "thinking_delta", text: "结论" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "结论" });
    expect(attempts).toBe(1);
  });

  it("空 text 且无任何 thinking：仍抛「快速模型返回为空」", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型返回为空");
  });

  it("refusal 仍抛模型停止原因（不做空结果兜底）", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        yield { type: "thinking_delta", text: "被拒绝前的思考" };
        yield { type: "done", stopReason: "refusal" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("模型停止原因：refusal");
  });
});
