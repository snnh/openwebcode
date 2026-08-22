/**
 * OpenAI Responses 回放公共工具：provider 回放（从持久化 reasoning item 签名提取纯文本
 * reasoning_text、从文本块 textSignature 解析 message item id/phase）与旧会话格式升级
 * （为无签名的 thinking 块/tool_call 固化 Responses 原始 id）共用同一套解析与派生规则。
 *
 * 依赖方向：providers/openai-responses-provider 与 sessions 层均只依赖本模块；
 * 本模块不得反向依赖 provider/session 具体实现。
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../sessions/types.js";

/** 解析 thinking 块持久化的 reasoning item 签名（OpenAI Responses 原始 item JSON）。
 * 返回完整 reasoning item（含 id/content）供调用方取用；非 Responses 载荷（如 Anthropic
 * redacted 密文、损坏 JSON、缺 content 的空壳）返回 undefined，由调用方回退块文本。 */
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

/** 解析 web_search_call 块持久化的服务端原始 item JSON：回放时按文档「Pass back as-is」
 * 原样回传（服务端自动恢复搜索结果）。非法载荷返回 undefined（调用方跳过该块）。 */
export function parseWebSearchCallSignature(signature: string | undefined): Record<string, unknown> | undefined {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.type === "web_search_call" && typeof parsed.id === "string") {
      return parsed;
    }
  } catch {
    // 非 JSON：跳过
  }
  return undefined;
}

/** 为回放/升级固化 item 派生稳定 id（前缀 + 内容短哈希）：旧数据无原始 id 时的兜底，
 * 保持产物稳定（官方 id 形如 rs_/msg_<24 hex>，≤64 字符）。seed 含消息 id 与块位置，
 * 同一消息重复升级/回放产出相同 id。 */
function deriveItemId(prefix: "rs_" | "msg_", seed: string): string {
  return `${prefix}${createHash("sha1").update(seed).digest("hex").slice(0, 24)}`;
}

/** 为格式升级固化的 reasoning item 派生稳定 id（rs_ + 内容短哈希）：旧数据无原始 id 时
 * 的兜底，保持升级产物稳定（官方 id 形如 rs_<24 hex>）。 */
function deriveReasoningId(seed: string): string {
  return deriveItemId("rs_", seed);
}

/** 文本块回放签名 v1 编码（dsh 口径）：{v:1,id,phase?}。Responses message output_item.done
 * 收尾时随 text_end 事件持久化，回放时解析出 message item 的原始 id/phase 原样回传。 */
export function encodeTextSignatureV1(id: string, phase?: string): string {
  const payload: Record<string, unknown> = { v: 1, id };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}

/** 解析文本块持久化的 v1 文本签名（{"v":1,"id":...,"phase"?}，dsh 口径）：返回回放所需的
 * message item id；phase 仅接受 "commentary"|"final_answer"（其余取值视为无 phase）。非 JSON
 * 的旧式纯字符串按 legacy id 原样返回；非法载荷返回 undefined（调用方派生兜底 id）。 */
export function parseTextSignature(signature: string | undefined): { id: string; phase?: string } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // 非 JSON：回落到 legacy 纯字符串处理
    }
  }
  return { id: signature };
}

/** 为回放 message item 派生稳定 id（msg_ + 内容短哈希）：无 textSignature 时的兜底，
 * 保持回放产物稳定（官方 id 形如 msg_<24 hex>，≤64 字符，与 deriveReasoningId 同风格）。 */
export function deriveMessageItemId(seed: string): string {
  return deriveItemId("msg_", seed);
}

/** 为格式升级固化的 function_call 派生 item id（fc_ 前缀 + 清洗后的 call_id）：旧数据
 * 无持久化原始 fc id 时的兜底（要求 fc_ 前缀，OpenAI 官方 64 字符上限）。 */
function deriveFcId(callId: string): string {
  const sanitized = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
  // 先去尾部下划线再截断，避免全符号/尾下划线的 call_id 产出空尾 fc_（无效 id）
  const trimmed = sanitized.replace(/_+$/, "").slice(0, 61);
  return `fc_${trimmed === "" ? "0" : trimmed}`;
}

/**
 * 旧会话消息 → 新格式（幂等）：
 * - 无 signature 的非 Anthropic thinking 块（text 非空）补 Responses 格式 signature——
 *   固化稳定 id，供诊断与未来需要原样回放的严格端点使用；
 * - 无 itemId 的 tool_call 补派生 fc_ id（同上，固化而非请求时派发）。
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
