/**
 * 会话存储公共 helper：SessionStore 与 ChatSessionStore 共用，
 * 避免两份逐字重复的派生标题 / 追加串行化实现各自漂移。
 */

import type { ChatMessage, MessageContent } from "./types.js";

/** 派生标题的截取长度（首条用户文本消息的前 80 字符）。 */
const DERIVED_TITLE_LENGTH = 80;

/**
 * 附件引用块（`@文件` 引用经 server 读取后组装的前置 text 块）不是用户输入，
 * 派生标题时必须跳过：否则纯附件消息的标题会是文件内容的前 80 字符。
 */
function isAttachmentBlock(text: string): boolean {
  return text.startsWith("[Attachment ");
}

/** 取首个「非附件引用」的非空文本块；全是附件块时退回首个非空文本块。 */
function titleTextOf(content: readonly MessageContent[]): string | undefined {
  const texts = content.filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text" && Boolean(block.text.trim()));
  return (texts.find((block) => !isAttachmentBlock(block.text)) ?? texts[0])?.text;
}

/** 派生标题：首条非空用户文本消息的前 80 字符；无消息时回退 fallback。 */
export function deriveTitleFromMessages(messages: readonly ChatMessage[], fallback: string): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = titleTextOf(message.content);
    if (text !== undefined) return text.slice(0, DERIVED_TITLE_LENGTH);
  }
  return fallback;
}

/** appendMessage 的自动命名：消息内容首个文本块的前 80 字符（无文本块返回 undefined）。 */
export function titleFromContent(content: MessageContent[]): string | undefined {
  const text = titleTextOf(content);
  return text === undefined ? undefined : text.slice(0, DERIVED_TITLE_LENGTH);
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
