import { randomUUID } from "node:crypto";
import type { EffortLevel, ThinkingMode } from "./context/model-profile.js";
import type { ProviderRegistry } from "./providers/provider.js";

export interface FastModelConfig {
  provider: string;
  model: string;
  thinking?: ThinkingMode;
  effort?: EffortLevel;
}

export interface FastModelCompletion {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Internal low-latency completion client backed by the normal provider
 * registry. Credentials, interface type, and endpoint always come from the
 * selected named model provider; the fast-model setting only selects a model
 * and request parameters. */
export class FastModelClient {
  private config: FastModelConfig | undefined;

  constructor(private readonly providers: ProviderRegistry, config?: FastModelConfig) {
    this.config = config;
  }

  setConfig(config: FastModelConfig | undefined): void {
    this.config = config;
  }

  get configured(): boolean {
    return this.config !== undefined;
  }

  get provider(): string | undefined {
    return this.config?.provider;
  }

  get model(): string | undefined {
    return this.config?.model;
  }

  async complete(input: { system: string; prompt: string; maxTokens: number }): Promise<FastModelCompletion> {
    const config = this.config;
    if (!config) throw new Error("快速模型未配置");
    const provider = this.providers.get(config.provider);
    if (!provider) throw new Error(`快速模型服务商不可用：${config.provider}`);
    // 无全局输出上限：maxTokens 由调用方按任务显式指定
    const maxTokens = input.maxTokens;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const event of provider.streamChat({
        model: config.model,
        ...(config.thinking ? { thinking: config.thinking } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        system: input.system,
        messages: [{
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          createdAt: new Date().toISOString(),
        }],
        tools: [],
        maxTokens,
        signal: AbortSignal.timeout(60_000),
      })) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "usage") {
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        } else if (event.type === "done" && (event.stopReason === "refusal" || event.stopReason === "error")) {
          throw new Error(`模型停止原因：${event.stopReason}`);
        }
      }
    } catch (error) {
      throw new Error(`快速模型请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (text.trim() === "") throw new Error("快速模型返回为空");
    return { text, usage: { inputTokens, outputTokens } };
  }
}
