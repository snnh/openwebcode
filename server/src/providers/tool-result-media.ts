/**
 * tool_result 附带媒体（ToolResultContent.media，read_media 产物）的按端点投递适配：
 * - anthropic：媒体内联进 tool_result 块（image 走 base64 source；Anthropic 无视频块形态，
 *   视频降级为占位文本，不猜未公开的视频块结构）；
 * - openai-chat-completions：tool 消息保持纯文本，媒体抽出为紧随其后的合成 user 消息
 *   （image_url / video_url data URL）；
 * - openai-responses：tool 输出同样纯文本，媒体合成 user 消息（input_image）；
 *   视频端点不支持，降级占位文本。
 * 三个 provider 各自在消息映射入口调用本模块，共用同一份收集/降级规则。
 */
import type { ChatMessage, ImageContent, VideoContent } from "../sessions/types.js";

export interface ToolMediaItem {
  kind: "image" | "video";
  mediaType: string;
  data: string;
}

/** 视频在不支持端点上的占位文本（模型可见，如实说明缺失原因）。 */
export const VIDEO_OMITTED_PLACEHOLDER = "(video omitted: not supported by this provider)";

/** 合成 user 消息的引导行（openai 系两条路径共用）。 */
export const MEDIA_ATTACHMENT_NOTE = "Attached media from tool result:";

/**
 * toolCallId → 附带媒体（仅 data 内联形态；ref 形态由调用方内联后才会有 data，
 * 缺 data 的块不进 provider——与 user 消息图片块的既有口径一致）。
 */
export function collectToolMedia(messages: ChatMessage[]): Map<string, ToolMediaItem[]> {
  const media = new Map<string, ToolMediaItem[]>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || media.has(block.toolCallId)) continue;
      const items = (block.media ?? [])
        .filter((item): item is (ImageContent | VideoContent) & { data: string } => typeof item.data === "string" && item.data.length > 0)
        .map((item) => ({ kind: item.type, mediaType: item.mediaType, data: item.data }));
      if (items.length > 0) media.set(block.toolCallId, items);
    }
  }
  return media;
}

/**
 * anthropic：tool_result 的 content 由纯字符串升级为 [text, image…] 块数组；
 * 无媒体时原样返回字符串（保持既有请求逐字节不变）。视频降级为占位文本。
 */
export function anthropicToolResultContent(content: string, media: ToolMediaItem[] | undefined): string | Array<Record<string, unknown>> {
  if (!media || media.length === 0) return content;
  return [
    { type: "text", text: content },
    ...media.map((item) => item.kind === "image"
      ? { type: "image", source: { type: "base64", media_type: item.mediaType, data: item.data } }
      : { type: "text", text: VIDEO_OMITTED_PLACEHOLDER }),
  ];
}

/** openai-chat-completions：合成 user 消息 parts（image_url / video_url data URL）。 */
export function openaiCompatibleMediaMessage(media: ToolMediaItem[]): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text: MEDIA_ATTACHMENT_NOTE },
      ...media.map((item) => item.kind === "image"
        ? { type: "image_url", image_url: { url: `data:${item.mediaType};base64,${item.data}` } }
        : { type: "video_url", video_url: { url: `data:${item.mediaType};base64,${item.data}` } }),
    ],
  };
}

/** openai-responses：合成 user 消息（input_image）；视频降级为占位文本（端点无视频输入形态）。 */
export function openaiResponsesMediaMessage(media: ToolMediaItem[]): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "input_text", text: MEDIA_ATTACHMENT_NOTE },
      ...media.map((item) => item.kind === "image"
        ? { type: "input_image", detail: "auto", image_url: `data:${item.mediaType};base64,${item.data}` }
        : { type: "input_text", text: VIDEO_OMITTED_PLACEHOLDER }),
    ],
  };
}
