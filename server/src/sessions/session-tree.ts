import type { ChatMessage } from "./types.js";

/**
 * 会话消息树的活动路径：从 leaf 沿 parentId 走到根，返回根→leaf 顺序的数组。
 * leafId 缺失（legacy 线性会话）或 leaf 不在树中（悬挂）时回退整表，
 * 保持旧的线性行为；父链成环时防御性截断。
 * agent 上下文组装、timeline 的 onActivePath 与 fork 共用这一份树遍历。
 */
export function activePathMessages(messages: ChatMessage[], leafId: string | undefined): ChatMessage[] {
  if (!leafId) return messages;
  const byId = new Map<string, ChatMessage>();
  for (const message of messages) byId.set(message.id, message);
  const leaf = byId.get(leafId);
  if (!leaf) return messages;
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let cursor: ChatMessage | undefined = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.reverse();
}
