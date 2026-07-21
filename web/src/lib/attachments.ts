import type { MessageAttachment } from "./contracts";

/**
 * 从输入框文本提取 `@<relpath>` 引用（去重，保序）。
 * @ 标记本身保留在正文里作为上下文；提取出的相对路径作为 attachments 字段提交，
 * server 在 appendMessage 前对每个 path 调 core.readFile 注入为前置 text 块。
 * (?<!\S) lookbehind 要求 @ 前为空白或行首，排除邮箱 user@host 形态。
 */
const ATTACHMENT_PATTERN = /(?<!\S)@([^\s@]+)/g;
// Composer emits this marker when a PDF is intentionally passed as a plain
// workspace path. Treat it as opaque: an `@` in a filename must not turn into
// an unrelated file attachment when the draft is sent.
const PDF_PATH_MARKER_PATTERN = /\[PDF path: [^\]\r\n]*\]/g;

export function extractAttachmentPaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const pdfPathRanges = [...text.matchAll(PDF_PATH_MARKER_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const start = match.index ?? 0;
    if (pdfPathRanges.some((range) => start >= range.start && start < range.end)) continue;
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
