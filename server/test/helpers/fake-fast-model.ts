import type { FastModelClient } from "../../src/fast-model.js";

/**
 * 已配置的 fake 快速模型：complete 固定返回 text，usage 固定 120/30；
 * 传入 calls 时记录每次调用的 { system, prompt }。
 */
export function makeFakeFastModel(text: string, calls?: Array<{ system: string; prompt: string }>): FastModelClient {
  return {
    configured: true,
    provider: "fast-provider",
    model: "fake-cheap-model",
    setConfig() { /* noop */ },
    async complete(input: { system: string; prompt: string }) {
      calls?.push(input);
      return { text, usage: { inputTokens: 120, outputTokens: 30 } };
    },
  } as unknown as FastModelClient;
}
