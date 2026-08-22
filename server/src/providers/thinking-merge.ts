/**
 * B3 合并（agent-runner / sub-agent / chat-runner 共用）：无活动 thinking 槽位时，
 * 按 reasoning item 的 id 匹配既有 thinking 块原位替换（第二次 thinking_end 以
 * enriched signature 覆盖早期块，避免追加出重复块）。签名非 JSON、无字符串 id
 * 或未匹配到同源块时返回 false，由调用方按现状追加（Anthropic redacted 密文等
 * 不受影响）。
 */
import type { MessageContent } from "../sessions/types.js";

export function replaceThinkingBlockById(blocks: MessageContent[], signature: string, completed: MessageContent): boolean {
  let targetId: unknown;
  try {
    targetId = (JSON.parse(signature) as { id?: unknown }).id;
  } catch {
    return false;
  }
  if (typeof targetId !== "string") return false;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block?.type !== "thinking" || block.signature === undefined) continue;
    let blockId: unknown;
    try {
      blockId = (JSON.parse(block.signature) as { id?: unknown }).id;
    } catch {
      continue;
    }
    if (blockId === targetId) {
      blocks[index] = completed;
      return true;
    }
  }
  return false;
}
