import type { ChatMessage, MessageContent, SessionDetail } from "./sessions/types.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内最小 Markdown：`code` 与 **bold**（输入已转义） */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** 最小 Markdown：``` 代码块、-/* 与 1. 列表、段落（手写，不引依赖） */
function renderMarkdown(source: string): string {
  const html: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  let ordered = false;
  const flushParagraph = (): void => {
    if (paragraph.length) html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) {
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const isOrdered = /^\s*\d/.test(line);
      if (!list || ordered !== isOrdered) { flushList(); list = []; ordered = isOrdered; }
      list!.push(item[1]!);
      continue;
    }
    flushList();
    if (line.trim() === "") { flushParagraph(); continue; }
    paragraph.push(line);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("\n");
}

function renderBlock(block: MessageContent): string {
  switch (block.type) {
    case "text":
      return `<div class="text">${renderMarkdown(block.text)}</div>`;
    case "thinking":
      return `<details class="thinking"><summary>思考过程</summary>${renderMarkdown(block.text)}</details>`;
    case "tool_call":
      return `<div class="tool-call"><span class="tool-name">${escapeHtml(block.name)}</span><pre><code>${escapeHtml(JSON.stringify(block.input, null, 2))}</code></pre></div>`;
    case "tool_result":
      return `<details class="tool-result${block.isError ? " error" : ""}"><summary>工具结果${block.isError ? "（错误）" : ""}</summary><pre><code>${escapeHtml(block.content)}</code></pre></details>`;
    case "image":
      // base64 仅含 [A-Za-z0-9+/=]，无需再转义
      return `<img class="msg-image" src="data:${escapeHtml(block.mediaType)};base64,${block.data}" alt="图片">`;
  }
}

const ROLE_LABELS: Record<ChatMessage["role"], string> = { user: "用户", assistant: "助手", tool: "工具" };

function renderMessage(message: ChatMessage): string {
  const body = message.content.map(renderBlock).join("\n");
  return `<section class="msg ${message.role}">
<div class="msg-head"><span class="role">${ROLE_LABELS[message.role]}</span><time>${escapeHtml(message.createdAt)}</time></div>
${body}
</section>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 16px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2329; }
main { max-width: 860px; margin: 0 auto; }
header.page { margin-bottom: 20px; }
header.page h1 { margin: 0 0 4px; font-size: 20px; }
header.page .meta { color: #6b7280; font-size: 12px; }
.msg { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
.msg.user { border-left: 3px solid #3b82f6; }
.msg.assistant { border-left: 3px solid #10b981; }
.msg.tool { border-left: 3px solid #f59e0b; }
.msg-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.role { font-weight: 600; font-size: 12px; color: #6b7280; }
time { font-size: 11px; color: #9ca3af; }
.text p { margin: 6px 0; }
pre { background: #f1f3f5; border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; }
code { font-family: Consolas, "Courier New", monospace; }
p code, li code { background: #f1f3f5; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
ul, ol { margin: 6px 0; padding-left: 22px; }
details { margin: 6px 0; }
summary { cursor: pointer; color: #6b7280; font-size: 12.5px; }
.tool-call { margin: 6px 0; }
.tool-name { display: inline-block; background: #eef2ff; color: #4f46e5; border-radius: 4px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
.tool-result.error summary { color: #dc2626; }
.msg-image { max-width: 100%; border-radius: 8px; }
.empty { color: #9ca3af; text-align: center; padding: 40px 0; }
footer.page { margin-top: 20px; text-align: center; color: #9ca3af; font-size: 11px; }
@media (prefers-color-scheme: dark) {
  body { background: #14161a; color: #e5e7eb; }
  .msg { background: #1d2025; border-color: #2c3138; }
  pre, p code, li code { background: #262b32; }
  .tool-name { background: #2c2f4a; color: #a5b4fc; }
}
`;

/** 会话导出为自包含 HTML 分享页：内联样式、零外部资源、全部用户/模型文本转义。 */
export function renderSessionHtml(detail: SessionDetail): string {
  const title = escapeHtml(detail.title);
  const meta = escapeHtml(`${detail.provider} · ${detail.model} · ${detail.createdAt} · ${detail.cwd}`);
  const messages = detail.messages.length
    ? detail.messages.map(renderMessage).join("\n")
    : `<p class="empty">暂无消息</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - OpenWebCode 会话导出</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="page">
<h1>${title}</h1>
<div class="meta">${meta}</div>
</header>
${messages}
<footer class="page">由 OpenWebCode 导出 · ${escapeHtml(detail.id)}</footer>
</main>
</body>
</html>
`;
}
