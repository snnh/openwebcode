import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchFollowingRedirects, readResponseLimited, withTimeout } from "../http-utils.js";
import { getUserAgent } from "../user-agent.js";
import type { Provider, ProviderRegistry } from "../providers/provider.js";
import type { ProviderProfilesService } from "../provider-profiles.js";
import type { ChatMessage } from "../sessions/types.js";
import { assertSafeWebUrl } from "../web-tools.js";
import type { ChatConfigService } from "./chat-config.js";
import type { ImageGenProvider, VisionProvider } from "./chat-tools.js";

/** chat 图片允许的媒体类型 → 落盘扩展名（与 ImageContent 现状口径一致）。 */
const CHAT_IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 图片落盘/抓取上限（base64 前 10MB）。 */
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 内嵌 messages.jsonl 上限（base64 前 2MB）；超出走 uploads/ 落盘 + ref 块。 */
export const CHAT_INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export function extForMediaType(mediaType: string): string | undefined {
  return CHAT_IMAGE_MEDIA_TYPES[mediaType.toLowerCase()];
}

export function mediaTypeForFile(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  for (const [mediaType, candidate] of Object.entries(CHAT_IMAGE_MEDIA_TYPES)) {
    if (candidate === ext || (mediaType === "image/jpeg" && ext === "jpeg")) return mediaType;
  }
  return undefined;
}

/** 会话目录内路径解析：拒绝越出 sessionDir 的相对路径（../ 穿越）。 */
export function resolveSessionPath(sessionDir: string, inputPath: string): string {
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes session directory: ${inputPath}`);
  }
  return resolved;
}

// ---- vision 图源抓取（http(s) URL 形态）----

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const IMAGE_FETCH_MAX_REDIRECTS = 5;

/**
 * vision 工具的 http(s) 图源抓取：SSRF 块表逐跳复验（手动重定向）+ 10MB 上限 + image/* 校验。
 * 复用 web-tools 的 assertSafeWebUrl 网关惯例（webFetchProvider 只回文本，不适用二进制图）。
 */
export async function fetchChatImage(
  value: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ data: string; mediaType: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? CHAT_IMAGE_MAX_BYTES;
  const signal = withTimeout(options.signal, IMAGE_FETCH_TIMEOUT_MS);
  const { response } = await fetchFollowingRedirects({
    fetchImpl,
    start: assertSafeWebUrl(value),
    signal,
    headers: { "User-Agent": getUserAgent(), Accept: "image/*" },
    maxRedirects: IMAGE_FETCH_MAX_REDIRECTS,
    // 与 webFetch 同一 SSRF 网关：重定向目标逐跳复验块表
    validate: (url) => {
      assertSafeWebUrl(url.href);
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(`URL did not return an image (content-type: ${contentType || "unknown"})`);
  }
  const bytes = await readResponseLimited(response, maxBytes);
  return { data: Buffer.from(bytes).toString("base64"), mediaType: contentType };
}

// ---- image_gen：OpenAI 兼容 images API ----

export type ImageAspectRatio = "1:1" | "3:2" | "2:3" | "16:9" | "9:16";

export const IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = ["1:1", "3:2", "2:3", "16:9", "9:16"];

/** aspectRatio → OpenAI size。1216x832 等非标准取值部分 provider 会拒绝：错误如实透传，不做二次映射。 */
const ASPECT_RATIO_SIZE: Readonly<Record<ImageAspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1216x832",
  "2:3": "832x1216",
  "16:9": "1344x768",
  "9:16": "768x1344",
};

const IMAGE_GEN_TIMEOUT_MS = 120_000;
const IMAGE_GEN_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** OpenAI 兼容图像生成：POST <baseURL>/images/generations（response_format=b64_json）。 */
export function createOpenAIImageGenProvider(options: {
  name: string;
  model: string;
  baseURL: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
}): ImageGenProvider {
  const baseURL = options.baseURL.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    name: options.name,
    async generate(prompt, generateOptions) {
      const size = ASPECT_RATIO_SIZE[generateOptions?.aspectRatio ?? "1:1"];
      const signal = withTimeout(generateOptions?.signal, IMAGE_GEN_TIMEOUT_MS);
      const response = await fetchImpl(`${baseURL}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": getUserAgent(),
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: options.model, prompt, n: 1, size, response_format: "b64_json" }),
        signal,
      });
      const raw = await readResponseLimited(response, IMAGE_GEN_MAX_RESPONSE_BYTES);
      if (!response.ok) {
        const detail = new TextDecoder().decode(raw).slice(0, 500);
        throw new Error(`Image generation failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
      }
      let body: { data?: Array<{ b64_json?: unknown }> };
      try {
        body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
      } catch {
        throw new Error("Image generation returned invalid JSON");
      }
      const b64 = body.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64) throw new Error("Image generation returned no image data");
      return { data: b64, mediaType: "image/png" };
    },
  };
}

// ---- vision：复用 ProviderRegistry chat 通路 ----

export type VisionReasoning = "off" | "low" | "medium" | "high";

/**
 * 视觉理解适配器：构造含 image 块 + prompt 的单条 user 消息，走所选 provider 的
 * streamChat 通路收集流式文本。reasoning 缺省 off；low/medium/high 映射到 thinking=enabled + effort。
 */
export function createProviderVisionProvider(options: { name: string; model: string; provider: Provider }): VisionProvider {
  return {
    name: options.name,
    async analyze(image, prompt, analyzeOptions) {
      const reasoning: VisionReasoning = analyzeOptions?.reasoning ?? "off";
      const messages: ChatMessage[] = [{
        id: randomUUID(),
        role: "user",
        content: [
          { type: "image", data: image.data, mediaType: image.mediaType },
          { type: "text", text: prompt },
        ],
        createdAt: new Date().toISOString(),
      }];
      let answer = "";
      const stream = options.provider.streamChat({
        model: options.model,
        system: "",
        messages,
        tools: [],
        thinking: reasoning === "off" ? "disabled" : "enabled",
        ...(reasoning === "off" ? {} : { effort: reasoning }),
        signal: withTimeout(analyzeOptions?.signal, IMAGE_GEN_TIMEOUT_MS),
      });
      for await (const event of stream) {
        if (event.type === "text_delta") answer += event.text;
      }
      return answer;
    },
  };
}

// ---- 适配器现读（chat.json 热生效）----

/** image_gen 适配器现读：chat.json imageGenModel + provider profiles 凭据（apiKey/baseURL）。 */
export async function resolveChatImageGenProvider(
  chatConfig: ChatConfigService,
  profiles: ProviderProfilesService | undefined,
): Promise<ImageGenProvider | undefined> {
  const selection = (await chatConfig.get()).imageGenModel;
  if (!selection) return undefined;
  const profile = profiles?.modelProfiles().find((item) => item.id === selection.provider && item.enabled);
  if (!profile) return undefined;
  return createOpenAIImageGenProvider({
    name: selection.provider,
    model: selection.model,
    baseURL: profile.baseURL ?? "https://api.openai.com/v1",
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
  });
}

/** vision 适配器现读：chat.json visionModel + ProviderRegistry 对应 provider。 */
export async function resolveChatVisionProvider(
  chatConfig: ChatConfigService,
  providers: ProviderRegistry,
): Promise<VisionProvider | undefined> {
  const selection = (await chatConfig.get()).visionModel;
  if (!selection) return undefined;
  const provider = providers.get(selection.provider);
  if (!provider) return undefined;
  return createProviderVisionProvider({ name: selection.provider, model: selection.model, provider });
}

/** image_gen 产出落盘 <sessionDir>/generated/<uuid>.<ext>，返回相对 ref。 */
export async function saveGeneratedImage(sessionDir: string, image: { data: string; mediaType: string }): Promise<string> {
  const ext = extForMediaType(image.mediaType) ?? "png";
  const ref = `generated/${randomUUID()}.${ext}`;
  const resolved = resolveSessionPath(sessionDir, ref);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, Buffer.from(image.data, "base64"));
  return ref;
}
