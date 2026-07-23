import { describe, expect, it } from "vitest";
import { FastModelClient } from "../src/fast-model.js";
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
      maxTokens: 2_048,
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

  it("caps task output at the configured maximum and reports unavailable providers", async () => {
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
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1", maxTokens: 256 });
    await client.complete({ system: "system", prompt: "prompt", maxTokens: 1_024 });
    expect(requests[0]?.maxTokens).toBe(256);

    client.setConfig({ provider: "disabled-provider", model: "fast-2", maxTokens: 256 });
    await expect(client.complete({ system: "system", prompt: "prompt" })).rejects.toThrow("快速模型服务商不可用");
  });
});
