import type { ChatMessage } from "./types.js";

/**
 * 上下文注入消息（模式/日期引导，kimi-code 式 reminder）的 id 前缀。
 * 消息以 user 角色落盘于活动路径，供模型消费；WebUI 面向服务端过滤（不可见）。
 * 识别点：活动路径扫描（去重/节奏）、用户轮计数、前端消息接口过滤、标题派生排除。
 */
export const INJECTION_MESSAGE_ID_PREFIX = "inj:";

export function isInjectionMessageId(id: string): boolean {
  return id.startsWith(INJECTION_MESSAGE_ID_PREFIX);
}

/**
 * 会话消息树的活动路径：从 leaf 沿 parentId 走到根，返回根→leaf 顺序的数组。
 * leafId 缺失（legacy 线性会话）或 leaf 不在树中（悬挂）时回退整表，
 * 保持旧的线性行为；父链成环时防御性截断。
 * agent 上下文组装、timeline 的 onActivePath 与 fork 共用这一份树遍历。
 */
export function activePathMessages(messages: ChatMessage[], leafId: string | undefined): ChatMessage[] {
  if (!leafId) return messages;
  // 线性快路径：现实会话绝大多数是无分叉线性链，messages 本身就是根→leaf 的
  // 活动路径。验证通过则免建全量 id→message 的 Map（agent 主循环每轮调用两次，
  // 长会话每轮都要建两个全量 Map）。slice 保持原契约：成功路径返回新数组
  //（全部调用方只读，且旧实现在此路径本就返回新建的 path 数组）。
  if (isLinearChain(messages, leafId)) return messages.slice();
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

/**
 * 验证 messages 恰好是根→leaf 的线性活动路径：末条即 leaf，且其余各条的
 * parentId 依次指向前一条的 id。首条的 parentId 不影响结果（链已覆盖全部
 * 消息时，Map 路径在首条之后同样查不到父节点而停止）。任一条件不满足立即
 * 回退 Map 路径（分叉、checkout 到中间节点、乱序、悬挂 parentId 等）。
 */
function isLinearChain(messages: ChatMessage[], leafId: string): boolean {
  const last = messages.at(-1);
  if (!last || last.id !== leafId) return false;
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.parentId !== messages[index - 1]!.id) return false;
  }
  return true;
}
