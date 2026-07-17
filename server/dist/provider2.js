/**
 * provider2 一次性文本补全客户端（非流式，/chat/completions）。
 * 只服务内部任务：上下文压缩、将来的标题生成/翻译等。
 */
export class Provider2Client {
    config;
    constructor(config) {
        this.config = config;
    }
    setConfig(config) {
        this.config = config;
    }
    get configured() {
        return this.config !== undefined;
    }
    get model() {
        return this.config?.model;
    }
    async complete(input) {
        if (!this.config)
            throw new Error("provider2 未配置");
        const baseURL = this.config.baseURL.replace(/\/+$/, "");
        let response;
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
        }
        catch (error) {
            throw new Error(`provider2 请求失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 200);
            throw new Error(`provider2 请求失败：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
        }
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.trim() === "")
            throw new Error("provider2 返回为空");
        return {
            text,
            usage: {
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            },
        };
    }
}
