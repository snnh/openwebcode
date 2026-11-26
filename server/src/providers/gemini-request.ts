/**
 * Gemini 原生 `generateContent` 请求体构造（与 llm-api 传输层共用）。
 *
 * 仍由 OWC 自己组装 rawBody：历史消息里 thinking / tool_call 的交错顺序、
 * thoughtSignature、工具结果媒体与中断补位都需要按 OWC 的持久化形状处理；
 * llm-api 负责认证、URL、超时、SSE 解析与事件归一。
 */
import type { ChatMessage, ImageContent, VideoContent } from "../sessions/types.js";
import { ProviderError } from "./provider-error.js";
import type { ProviderTool, StreamChatRequest } from "./provider.js";
import { collectToolMedia, type ToolMediaItem } from "./tool-result-media.js";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** 官方根地址补 /v1beta；自定义网关按用户填写原样使用。 */
export function normalizeGeminiBaseURL(baseURL?: string): string {
  const raw = (baseURL?.trim() || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    if (url.hostname === "generativelanguage.googleapis.com" && (url.pathname === "" || url.pathname === "/")) {
      url.pathname = "/v1beta";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

export interface GeminiProviderOptions {
  /** 当前 provider 名：只回传同源 thinking 的 thoughtSignature。 */
  providerName?: string;
  extraBody?: Record<string, unknown>;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Record<string, unknown>[];
}

interface PendingCall {
  name: string;
  providerId?: string;
}

const INTERRUPTED_TOOL_RESULT = "The tool call was interrupted before a result was produced.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Responses 的 textSignature 是 v1 JSON；Gemini thoughtSignature 是 base64，不能互串。 */
function replayTextSignature(signature: string | undefined): string | undefined {
  return signature && !signature.startsWith("{") ? signature : undefined;
}

function toolResponse(content: string, isError: boolean): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    value = content;
  }
  if (isError) return { error: typeof value === "string" ? value : JSON.stringify(value) };
  if (isRecord(value)) return value;
  if (value === undefined || value === null || value === "") return {};
  return { result: value };
}

function mediaParts(media: readonly ToolMediaItem[]): Record<string, unknown>[] {
  return [
    { text: "Attached media from tool result:" },
    ...media.map((item) => ({ inlineData: { mimeType: item.mediaType, data: item.data } })),
  ];
}

function inlineMedia(block: ImageContent | VideoContent): Record<string, unknown> | undefined {
  return typeof block.data === "string" && block.data.length > 0
    ? { inlineData: { mimeType: block.mediaType, data: block.data } }
    : undefined;
}

function geminiThinkingConfig(request: StreamChatRequest): Record<string, unknown> | undefined {
  if (request.thinking === "disabled") {
    // effort_only 模型（Gemini 3+）没有关闭思考的 wire 形态；与库同口径明确拒绝，
    // 避免静默忽略用户选择。
    if (request.thinkingStyle === "effort_only") {
      throw new ProviderError("invalid_request", "Gemini effort_only models do not support disabled thinking", false);
    }
    return { thinkingBudget: 0, includeThoughts: false };
  }
  const config: Record<string, unknown> = {};
  if (request.effort !== undefined) config.thinkingLevel = request.effort;
  if (request.thinking === "enabled" || request.thinking === "adaptive" || request.thinkingStyle === "fixed" || request.thinkingStyle === "adaptive") {
    config.includeThoughts = true;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * OWC ChatMessage → Gemini contents。连续同角色消息合并；functionCall 与
 * functionResponse 按 pending 队列配对，中断缺失结果补错误响应，孤儿结果丢弃。
 */
function buildContents(messages: readonly ChatMessage[], providerName: string | undefined): {
  contents: GeminiContent[];
  pending: Map<string, PendingCall>;
} {
  const contents: GeminiContent[] = [];
  const pending = new Map<string, PendingCall>();
  const emitted = new Set<string>();
  const toolMedia = collectToolMedia(messages);
  const push = (role: GeminiContent["role"], parts: Record<string, unknown>[]): void => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const flushPending = (): void => {
    if (pending.size === 0) return;
    const parts: Record<string, unknown>[] = [];
    for (const [id, call] of pending) {
      emitted.add(id);
      parts.push({
        functionResponse: {
          ...(call.providerId ? { id: call.providerId } : {}),
          name: call.name,
          response: { error: INTERRUPTED_TOOL_RESULT },
        },
      });
    }
    pending.clear();
    push("user", parts);
  };

  for (const message of messages) {
    if (message.role === "tool") {
      const parts: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const call = pending.get(block.toolCallId);
        if (!call || emitted.has(block.toolCallId)) continue;
        pending.delete(block.toolCallId);
        emitted.add(block.toolCallId);
        parts.push({
          functionResponse: {
            ...(call.providerId ? { id: call.providerId } : {}),
            name: call.name,
            response: toolResponse(block.content, block.isError),
          },
        });
        const media = toolMedia.get(block.toolCallId);
        if (media) parts.push(...mediaParts(media));
      }
      push("user", parts);
      continue;
    }

    flushPending();
    if (message.role === "user") {
      const parts: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text) parts.push({ text: block.text });
        } else if (block.type === "image" || block.type === "video") {
          const part = inlineMedia(block);
          if (part) parts.push(part);
        }
      }
      push("user", parts);
      continue;
    }

    const parts: Record<string, unknown>[] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (providerName !== undefined && block.provider !== providerName) continue;
        if (!block.text && !block.signature) continue;
        parts.push({
          text: block.text,
          thought: true,
          ...(block.signature ? { thoughtSignature: block.signature } : {}),
        });
      } else if (block.type === "text") {
        const signature = replayTextSignature(block.textSignature);
        if (!block.text && !signature) continue;
        parts.push({ text: block.text, ...(signature ? { thoughtSignature: signature } : {}) });
      } else if (block.type === "image" || block.type === "video") {
        const part = inlineMedia(block);
        if (part) parts.push(part);
      } else if (block.type === "tool_call") {
        pending.set(block.id, {
          name: block.name,
          ...(block.providerId ? { providerId: block.providerId } : {}),
        });
        parts.push({
          functionCall: {
            ...(block.providerId ? { id: block.providerId } : {}),
            name: block.name,
            args: block.input,
          },
          ...(block.signature ? { thoughtSignature: block.signature } : {}),
        });
      }
    }
    push("model", parts);
  }
  return { contents, pending };
}

/** 构造 Gemini 原生请求体；核心字段由本函数强制，extraBody 只做补充。 */
export function buildGeminiBody(
  request: StreamChatRequest,
  options: GeminiProviderOptions = {},
): Record<string, unknown> {
  // serverWebSearch 只由 OpenAI Responses 消费；Gemini 内置 Google Search 尚未映射，
  // 与其他非 Responses 接口一样忽略该请求级标记，不阻断会话。
  const { contents, pending } = buildContents(request.messages, options.providerName);
  // 末尾仍缺结果的 tool_call：补占位响应，避免 Gemini 拒绝“有 functionCall 无 functionResponse”。
  if (pending.size > 0) {
    const parts = [...pending.values()].map((call) => ({
      functionResponse: {
        ...(call.providerId ? { id: call.providerId } : {}),
        name: call.name,
        response: { error: INTERRUPTED_TOOL_RESULT },
      },
    }));
    const last = contents.at(-1);
    if (last?.role === "user") last.parts.push(...parts);
    else contents.push({ role: "user", parts });
  }

  const systemTexts = [request.system, request.systemSuffix?.trim()].filter((text): text is string => Boolean(text));
  // deferLoading 仅 Anthropic Messages 序列化；Gemini 与其他 OpenAI 路径一样发送全部工具。
  const tools = request.tools.length > 0
    ? [{ functionDeclarations: request.tools.map((tool: ProviderTool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      })) }]
    : undefined;
  const generated: Record<string, unknown> = {};
  if (request.maxTokens !== undefined) generated.maxOutputTokens = request.maxTokens;
  if (request.temperature !== undefined) generated.temperature = request.temperature;
  if (request.topP !== undefined) generated.topP = request.topP;
  const thinking = geminiThinkingConfig(request);
  if (thinking) generated.thinkingConfig = thinking;

  const extra = options.extraBody ?? {};
  const extraGeneration = isRecord(extra.generationConfig) ? extra.generationConfig : {};
  const generationConfig = { ...extraGeneration, ...generated };
  return {
    ...extra,
    contents,
    ...(systemTexts.length > 0 ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    ...(tools ? { tools } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}
