/** provider2（上下文供应商，快速廉价模型）配置：OpenAI 兼容端点。 */
export interface Provider2Config {
  baseURL: string;
  apiKey?: string;
  model: string;
}

export interface Provider2Completion {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * provider2 一次性文本补全客户端（非流式，/chat/completions）。
 * 只服务内部任务：上下文压缩、将来的标题生成/翻译等。
 */
export class Provider2Client {
  private config: Provider2Config | undefined;

  constructor(config?: Provider2Config) {
    this.config = config;
  }

  setConfig(config: Provider2Config | undefined): void {
    this.config = config;
  }

  get configured(): boolean {
    return this.config !== undefined;
  }

  get model(): string | undefined {
    return this.config?.model;
  }

  async complete(input: { system: string; prompt: string; maxTokens?: number }): Promise<Provider2Completion> {
    if (!this.config) throw new Error("快速模型未配置");
    const baseURL = this.config.baseURL.replace(/\/+$/, "");
    let response: Response;
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
          max_tokens: input.maxTokens ?? 4096,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Error(`快速模型请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`快速模型请求失败：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") throw new Error("快速模型返回为空");
    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
