import { createHash } from "node:crypto";
import type { ContextHookPayload, ContextHookResult } from "./types.js";

/**
 * vision-tools（视觉工具）官方扩展的 Extension Host 侧实现：
 * context.beforeBuild 钩子——主模型不支持视觉时，把会话图片逐张交给配置的视觉模型
 * （server 侧 model.vision 复用 provider streamChat 发送链路）生成描述，以文本块
 * 替换 image 块注入上下文；支持视觉的主模型、未配置视觉模型、无图片的会话一律透传。
 * 描述按图片内容哈希缓存到扩展私有 storage，同一图片只调用一次视觉模型。
 *
 * 安全纪律：单图描述失败必须吞错并替换为占位文本——钩子异常会让 server 回退原始
 * payload（含图片），纯文本主模型收到图片后 provider 请求会报错。
 */

export interface VisionToolsHostApi {
  /** 会话元信息（provider/model 判断主模型视觉能力）。 */
  getSession(sessionId: string): Promise<{ provider?: string; model?: string }>;
  /** 模型能力查询（modalities 含 image 判定）。 */
  getCapabilities(model: string): Promise<{ vision: boolean }>;
  /** 图片 → 视觉模型描述（server 侧 provider.streamChat）。 */
  modelVision(input: { provider: string; model: string; prompt: string; thinking: boolean; maxTokens?: number; images: Array<{ mediaType: string; data: string }> }): Promise<{ text: string }>;
  /** 扩展私有存储（描述缓存）。 */
  storageRead(path: string): Promise<{ content: string | null }>;
  storageWrite(path: string, content: string): Promise<{ bytes: number }>;
}

export const VISION_DESCRIBE_SYSTEM = "请详细描述这张图片的内容：画面主体、关键细节、文字/代码（如有）、与开发任务相关的信息。使用与提问相同的语言回答。";

/** 缓存文件名：图片内容 sha1 → vision/<hash>.txt。 */
function cachePath(hash: string): string {
  return `vision/${hash}.txt`;
}

function clampMaxTokens(config: Record<string, unknown>): number | undefined {
  const raw = Number(config.maxTokens);
  return Number.isSafeInteger(raw) && raw >= 128 ? Math.min(raw, 4096) : undefined;
}

function describePrompt(config: Record<string, unknown>): string {
  const raw = config.prompt;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : VISION_DESCRIBE_SYSTEM;
}

/**
 * context.beforeBuild 钩子：纯文本主模型时把图片替换为视觉模型描述文本。
 * 返回 {} 表示不干预（透传原始 messages）。
 */
export async function bridgeVisionImages(
  api: VisionToolsHostApi,
  payload: ContextHookPayload,
  config: Record<string, unknown>,
): Promise<ContextHookResult> {
  // 模型选择器编码值：`provider/model`（与设置页模型选择同风格）
  const selection = typeof config.model === "string" ? config.model.trim() : "";
  const slash = selection.indexOf("/");
  const provider = slash > 0 ? selection.slice(0, slash).trim() : "";
  const model = slash > 0 ? selection.slice(slash + 1).trim() : "";
  if (!provider || !model) return {};
  const cacheEnabled = config.cacheDescriptions !== false;
  const maxTokens = clampMaxTokens(config);
  const thinking = config.thinking !== false;

  // 收集有 data 的图片块（ref 形态无法直接取图，跳过）
  const imageSpots: Array<{ messageIndex: number; blockIndex: number; mediaType: string; data: string }> = [];
  payload.messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type === "image" && typeof block.data === "string" && block.data !== "") {
        imageSpots.push({ messageIndex, blockIndex, mediaType: block.mediaType, data: block.data });
      }
    });
  });
  if (imageSpots.length === 0) return {};

  // 主模型支持视觉 → 原样透传（图片质量更高，不替换）
  try {
    const session = await api.getSession(payload.sessionId);
    if (session.provider && session.model) {
      const capabilities = await api.getCapabilities(session.model);
      if (capabilities.vision === true) return {};
    }
  } catch {
    // 能力查询失败不阻断：继续按纯文本主模型处理
  }

  const messages = payload.messages.map((message) => ({ ...message, content: [...message.content] }));
  const used = new Map<string, string>(); // data → 描述（同轮多张相同图只调一次）
  let described = 0;
  let cached = 0;
  let failed = 0;

  for (const spot of imageSpots) {
    const cachedText = used.get(spot.data);
    if (cachedText !== undefined) {
      messages[spot.messageIndex]!.content[spot.blockIndex] = { type: "text", text: cachedText };
      continue;
    }
    const hash = createHash("sha1").update(spot.data).digest("hex");
    let description: string | undefined;
    if (cacheEnabled) {
      try {
        const stored = await api.storageRead(cachePath(hash));
        if (stored?.content) {
          description = stored.content;
          cached += 1;
        }
      } catch {
        // 缓存读失败按未命中处理
      }
    }
    if (description === undefined) {
      try {
        const completion = await api.modelVision({
          provider,
          model,
          prompt: describePrompt(config),
          thinking,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          images: [{ mediaType: spot.mediaType, data: spot.data }],
        });
        description = completion.text.trim() !== "" ? completion.text.trim() : undefined;
        if (description && cacheEnabled) {
          void api.storageWrite(cachePath(hash), description).catch(() => undefined);
        }
        if (description) described += 1;
      } catch {
        failed += 1;
      }
    }
    if (description === undefined) {
      description = "[图片（视觉描述失败，请人工查看）]";
    }
    messages[spot.messageIndex]!.content[spot.blockIndex] = { type: "text", text: description };
    used.set(spot.data, description);
  }

  const metadata: Record<string, unknown> = { extension: "vision-tools", described, cached };
  if (failed > 0) metadata.failed = failed;
  return { messages, metadata };
}
