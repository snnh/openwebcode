import type { MessageAttachment } from "./contracts";

/**
 * 从输入框文本提取 `@<relpath>` 引用（去重，保序）。
 * @ 标记本身保留在正文里作为上下文；提取出的相对路径作为 attachments 字段提交，
 * server 在 appendMessage 前对每个 path 调 core.readFile 注入为前置 text 块。
 * (?<!\S) lookbehind 要求 @ 前为空白或行首，排除邮箱 user@host 形态。
 */
const ATTACHMENT_PATTERN = /(?<!\S)@([^\s@]+)/g;

export function extractAttachmentPaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    paths.push(raw);
  }
  return paths;
}

export function toAttachments(paths: string[]): MessageAttachment[] {
  return paths.map((p) => ({ path: p }));
}
