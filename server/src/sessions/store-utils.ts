/**
 * 会话存储公共 helper：SessionStore 与 ChatSessionStore 共用，
 * 避免两份逐字重复的派生标题 / 追加串行化实现各自漂移。
 */

import type { ChatMessage, MessageContent } from "./types.js";

/** 派生标题的截取长度（首条用户文本消息的前 80 字符）。 */
const DERIVED_TITLE_LENGTH = 80;

/** 派生标题：首条非空用户文本消息的前 80 字符；无消息时回退 fallback。 */
export function deriveTitleFromMessages(messages: readonly ChatMessage[], fallback: string): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.content.find((block) => block.type === "text");
    if (text?.type === "text" && text.text.trim()) return text.text.slice(0, DERIVED_TITLE_LENGTH);
  }
  return fallback;
}

/** appendMessage 的自动命名：消息内容首个文本块的前 80 字符（无文本块返回 undefined）。 */
export function titleFromContent(content: MessageContent[]): string | undefined {
  const firstText = content.find((block) => block.type === "text");
  return firstText?.type === "text" ? firstText.text.slice(0, DERIVED_TITLE_LENGTH) : undefined;
}

/**
 * 按 key 的串行化链：同一 key 的 fn 依次执行。
 * appendMessage 用它保证每会话串行追加——大消息并发追加时 appendFile 的
 * 多次 write 可能交织坏行（JSONL 破坏）。链尾结算后自清，避免 Map 随 key 数泄漏。
 */
export function serializeByKey<T>(chains: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
