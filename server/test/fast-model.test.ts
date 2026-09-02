import { describe, expect, it } from "vitest";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderRegistry, type ProviderEvent } from "../src/providers/provider.js";

describe("FastModelClient 单次尝试超时", () => {
  it("配置的 timeoutMs 生效：超时后快速失败（默认 60s，可调小）", async () => {
    const registry = new ProviderRegistry();
    // 永不产事件但响应 abort 的 provider：模拟慢速快速模型端点
    registry.register({
      name: "hang",
      async *streamChat(request): AsyncIterable<ProviderEvent> {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason ?? new Error("aborted")));
        });
      },
    });
    const fast = new FastModelClient(registry, { provider: "hang", model: "m", timeoutMs: 80 });
    const started = Date.now();
    await expect(fast.complete({ system: "s", prompt: "p", maxTokens: 16 })).rejects.toThrow(/快速模型请求失败/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
