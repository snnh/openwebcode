/**
 * 纯附件消息的文本占位。
 *
 * 会话持久化格式（messages.jsonl）不变：每条用户消息始终以「图片块 + 附件文本块 + 正文文本块」
 * 的顺序落盘，正文块必须存在。当用户只发图片/附件、没写文字时，这里生成一个可读占位作为正文，
 * 好处有三：① 空文本块不再进入 provider 请求（部分端点会以 400 拒收空 text part）；
 * ② 会话标题派生（titleFromContent 取首个 text 块前 80 字符）不会得到空标题；
 * ③ 界面与模型都能看出这条消息「只有图/附件」。
 *
 * 文案保持英文标记（与既有的 `[Attachment <path>]` 块一致，属机器插入文本，不随界面语言变化）。
 */

/** 最多列出几个附件名，超出用省略号（避免占位本身过长）。 */
const MAX_LISTED_ATTACHMENTS = 3;

function baseName(filePath: string): string {
  const trimmed = filePath.trim();
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

export function userMessageText(
  text: string,
  imageCount: number,
  attachmentPaths: readonly string[],
): string {
  if (text.trim()) return text;
  const parts: string[] = [];
  if (imageCount > 0) parts.push(imageCount === 1 ? "[Image]" : `[Image ×${imageCount}]`);
  if (attachmentPaths.length > 0) {
    const names = attachmentPaths.slice(0, MAX_LISTED_ATTACHMENTS).map(baseName).join(", ");
    const more = attachmentPaths.length > MAX_LISTED_ATTACHMENTS ? ", …" : "";
    const label = attachmentPaths.length === 1 ? "File" : `File ×${attachmentPaths.length}`;
    parts.push(`[${label}: ${names}${more}]`);
  }
  // 无图无附件时原样返回：调用方（REST 路由/agent 入口）已拒绝该组合，这里不伪造内容。
  return parts.join(" ") || text;
}
