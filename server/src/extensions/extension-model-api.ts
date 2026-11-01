import { randomUUID } from "node:crypto";
import type { FastModelClient } from "../fast-model.js";
import { withTimeout } from "../http-utils.js";
import type { ProviderRegistry } from "../providers/provider.js";

/** model.complete 强制上限：prompt 32 KiB、maxTokens 4096。 */
const MODEL_PROMPT_LIMIT = 32 * 1024;
const MODEL_MAX_TOKENS_LIMIT = 4096;
const MODEL_DEFAULT_MAX_TOKENS = 1024;

/** 解析 maxTokens：非正整数报错，合法值钳制在 1–4096。 */
function resolveMaxTokens(params: Record<string, unknown>, api: string): number | undefined {
  if (params.maxTokens === undefined) return undefined;
  const value = Number(params.maxTokens);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${api} maxTokens must be a positive integer`);
  return Math.min(value, MODEL_MAX_TOKENS_LIMIT);
}

/** model.complete：快速模型通道。prompt ≤32 KiB、maxTokens ≤4096（缺省 1024）。 */
export async function completeWithFastModel(fastModel: FastModelClient | undefined, params: Record<string, unknown>): Promise<unknown> {
  if (!fastModel?.configured) throw new Error("Fast model is not configured");
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (!prompt) throw new Error("model.complete requires a non-empty prompt string");
  if (Buffer.byteLength(prompt, "utf8") > MODEL_PROMPT_LIMIT) throw new Error(`model.complete prompt exceeds ${MODEL_PROMPT_LIMIT} bytes`);
  const maxTokens = resolveMaxTokens(params, "model.complete") ?? MODEL_DEFAULT_MAX_TOKENS;
  return fastModel.complete({ system: "You are a helper invoked by an openwebcode extension. Answer concisely.", prompt, maxTokens });
}

/**
 * model.vision：把图片交给指定 provider/model 生成描述（复用 chat 发送消息同一条
 * provider.streamChat 通路）。text_delta 优先、thinking_delta/thinking_end 兜底——
 * 思考型模型的正文可能全部落在思考通道。thinking 缺省开启。
 */
export async function describeWithVisionModel(providers: ProviderRegistry | undefined, params: Record<string, unknown>): Promise<unknown> {
  if (!providers) throw new Error("Provider registry is not configured");
  const providerName = typeof params.provider === "string" && params.provider ? params.provider : "";
  const model = typeof params.model === "string" && params.model ? params.model : "";
  if (!providerName || !model) throw new Error("model.vision requires provider and model");
  const provider = providers.get(providerName);
  if (!provider) throw new Error(`Vision provider is unavailable: ${providerName}`);
  const images = params.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
    throw new Error("model.vision requires 1-4 images");
  }
  const imageBlocks: Array<{ type: "image"; mediaType: string; data: string }> = [];
  for (const image of images) {
    if (!image || typeof image !== "object") throw new Error("model.vision image must be an object");
    const record = image as { mediaType?: unknown; data?: unknown };
    const mediaType = record.mediaType;
    if (typeof mediaType !== "string" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      throw new Error("model.vision image mediaType must be png/jpeg/webp/gif");
    }
    const data = record.data;
    if (typeof data !== "string" || data.length === 0 || data.length > 7_000_000 || !isCanonicalBase64(data)) {
      throw new Error("model.vision image data must be canonical base64 no larger than 7M chars");
    }
    imageBlocks.push({ type: "image", mediaType, data });
  }
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (!prompt) throw new Error("model.vision requires a non-empty prompt string");
  if (Buffer.byteLength(prompt, "utf8") > MODEL_PROMPT_LIMIT) throw new Error(`model.vision prompt exceeds ${MODEL_PROMPT_LIMIT} bytes`);
  const maxTokens = resolveMaxTokens(params, "model.vision");
  const thinking = params.thinking !== false;
  let text = "";
  let thinkingText = "";
  for await (const event of provider.streamChat({
    model,
    system: "You are a vision assistant invoked by an openwebcode extension. Describe the image accurately.",
    messages: [{
      id: randomUUID(),
      role: "user",
      content: [...imageBlocks, { type: "text", text: prompt }],
      createdAt: new Date().toISOString(),
    }],
    tools: [],
    thinking: thinking ? "enabled" : "disabled",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    signal: withTimeout(undefined, 60_000),
  })) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") thinkingText += event.text;
    else if (event.type === "thinking_end" && thinkingText === "") thinkingText = event.text;
    else if (event.type === "text_end" && text === "") text = event.text;
    else if (event.type === "done" && (event.stopReason === "refusal" || event.stopReason === "error")) {
      throw new Error(`模型停止原因：${event.stopReason}`);
    }
  }
  const finalText = text.trim() !== "" ? text : thinkingText.trim();
  if (finalText === "") throw new Error("视觉模型返回为空");
  return { text: finalText };
}

/** 规范 base64 校验（model.vision 图片数据；与消息上传同口径）。 */
function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
