/**
 * OpenAI Responses 思维链回放公共工具：provider 回放与旧会话格式升级共用，
 * 保证两处派生的 id 完全一致（升级固化的 signature/itemId 与回放端重建路径产出相同）。
 *
 * 依赖方向：providers/openai-responses-provider 与 sessions 层均只依赖本模块；
 * 本模块不得反向依赖 provider/session 具体实现。
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../sessions/types.js";

/** 解析 thinking 块持久化的 reasoning item 签名（OpenAI Responses 原始 item JSON）。
 * 返回完整 reasoning item（含 id/content）供原样回放；非 Responses 载荷（如 Anthropic
 * redacted 密文、损坏 JSON、缺 content 的空壳）返回 undefined，由调用方回退重建。 */
export function parseReasoningSignature(signature: string | undefined): Record<string, unknown> | undefined {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature) as Record<string, unknown>;
    if (
      parsed && typeof parsed === "object" &&
      parsed.type === "reasoning" &&
      typeof parsed.id === "string" &&
      Array.isArray(parsed.content) && parsed.content.length > 0
    ) {
      return parsed;
    }
  } catch {
    // 非 JSON（如 Anthropic redacted 密文）：不适用 Responses 回放
  }
  return undefined;
}

/** 为重建/占位 reasoning item 派生稳定 id（rs_ + 内容短哈希）：旧数据无原始 id 时的兜底，
 * 满足思维模式端点的 reasoning 项存在性/格式校验（官方 id 形如 rs_<24 hex>）。 */
export function deriveReasoningId(seed: string): string {
  return `rs_${createHash("sha1").update(seed).digest("hex").slice(0, 24)}`;
}

/** 为回放 function_call 派生 item id（fc_ 前缀 + 清洗后的 call_id）：旧数据无持久化原始
 * fc id 时的兜底，满足端点的 item id 格式校验（要求 fc_ 前缀，OpenAI 官方 64 字符上限）。 */
export function deriveFcId(callId: string): string {
  const sanitized = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const normalized = sanitized.length > 61 ? sanitized.slice(0, 61) : sanitized;
  return `fc_${normalized.replace(/_+$/, "")}`;
}

/**
 * 旧会话消息 → 新格式（幂等）：
 * - 无 signature 的非 Anthropic thinking 块（text 非空）补 Responses 格式 signature——
 *   派生 id 与回放端重建路径一致，升级后回放走原样还原分支；
 * - 无 itemId 的 tool_call 补派生 fc_ id（与回放端派生一致）。
 * Anthropic thinking 块（provider === "anthropic"）绝不碰：其 signature 是 redacted
 * 签名，语义不同，误补会破坏 Anthropic 回放。已升级块跳过，重复执行 changed === 0。
 */
export function upgradeResponsesReplayFields(messages: readonly ChatMessage[]): { messages: ChatMessage[]; changed: number } {
  let changed = 0;
  const upgraded = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.map((block) => {
      if (block.type === "thinking" && block.provider !== "anthropic" && block.text.trim() !== "" && block.signature === undefined) {
        changed += 1;
        return {
          ...block,
          signature: JSON.stringify({
            type: "reasoning",
            id: deriveReasoningId(`${message.id}:${block.text}`),
            content: [{ type: "reasoning_text", text: block.text }],
          }),
        };
      }
      if (block.type === "tool_call" && block.itemId === undefined) {
        changed += 1;
        return { ...block, itemId: deriveFcId(block.id) };
      }
      return block;
    });
    return content === message.content ? message : { ...message, content };
  });
  return { messages: upgraded, changed };
}
