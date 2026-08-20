import { randomUUID } from "node:crypto";
import type { EffortLevel, ThinkingMode } from "./context/model-profile.js";
import type { ProviderRegistry } from "./providers/provider.js";
import { collectProviderTurn } from "./providers/retry.js";
import { withTimeout } from "./http-utils.js";

export interface FastModelConfig {
  provider: string;
  model: string;
  thinking?: ThinkingMode;
  effort?: EffortLevel;
}

interface FastModelCompletion {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface FastModelAttempt {
  text: string;
  thinking: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string | undefined;
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
    // 无全局输出上限：maxTokens 由调用方按任务显式指定
    let attempt = await this.singleAttempt(config, input);
    if (attempt.text.trim() === "" && attempt.stopReason === "max_tokens") {
      // 思考型模型把预算全烧在推理上时正文可能为空：翻倍预算重试一次（不循环），usage 合并累加
      const retried = await this.singleAttempt(config, { ...input, maxTokens: input.maxTokens * 2 });
      attempt = {
        ...retried,
        usage: {
          inputTokens: attempt.usage.inputTokens + retried.usage.inputTokens,
          outputTokens: attempt.usage.outputTokens + retried.usage.outputTokens,
        },
      };
    }
    // 思考模型常把结论放在推理通道：正文为空时用 thinking 兜底（与 compact-vault 直连路径同款）
    const text = attempt.text.trim() !== "" ? attempt.text : attempt.thinking.trim();
    if (text === "") throw new Error("快速模型返回为空");
    return { text, usage: attempt.usage };
  }

  /** 单次调用：走 collectProviderTurn（小 maxAttempts），累积正文/推理增量与 usage，记录 stopReason。 */
  private async singleAttempt(
    config: FastModelConfig,
    input: { system: string; prompt: string; maxTokens: number },
  ): Promise<FastModelAttempt> {
    const provider = this.providers.get(config.provider);
    if (!provider) throw new Error(`快速模型服务商不可用：${config.provider}`);
    let text = "";
    let thinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    try {
      // 与主循环同一条重试路径（小 maxAttempts）：瞬时限流/半开连接可自愈，不再一次失败即报错
      const turn = await collectProviderTurn(provider, {
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
        maxTokens: input.maxTokens,
        signal: withTimeout(undefined, 60_000),
      }, { maxAttempts: 2 });
      for (const event of turn.events) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "thinking_delta") thinking += event.text;
        else if (event.type === "thinking_end" && thinking === "") thinking = event.text;
        else if (event.type === "text_end" && text === "") text = event.text;
        else if (event.type === "usage") {
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        } else if (event.type === "done") {
          if (event.stopReason === "refusal" || event.stopReason === "error") {
            throw new Error(`模型停止原因：${event.stopReason}`);
          }
          stopReason = event.stopReason;
        }
      }
    } catch (error) {
      throw new Error(`快速模型请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return { text, thinking, usage: { inputTokens, outputTokens }, stopReason };
  }
}
