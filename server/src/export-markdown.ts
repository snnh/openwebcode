import { activePathMessages } from "./sessions/session-tree.js";
import type { ChatMessage, MessageContent, SessionDetail } from "./sessions/types.js";

/** 工具结果正文的导出上限：超出部分截断并标注原始长度。 */
const TOOL_RESULT_LIMIT = 4000;

const ROLE_LABELS: Record<ChatMessage["role"], string> = { user: "用户", assistant: "助手", tool: "工具" };

/** 围栏长度自适应：正文含 ``` 时加长围栏，避免提前闭合。 */
function fence(content: string, language = ""): string {
  let ticks = "```";
  while (content.includes(ticks)) ticks += "`";
  return `${ticks}${language}\n${content}\n${ticks}`;
}

function renderBlock(block: MessageContent): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `<details>\n<summary>思考</summary>\n\n${block.text}\n\n</details>`;
    case "tool_call":
      return `### 工具调用：${block.name}\n\n${fence(JSON.stringify(block.input, null, 2), "json")}`;
    case "tool_result": {
      const truncated = block.content.length > TOOL_RESULT_LIMIT;
      const body = truncated
        ? `${block.content.slice(0, TOOL_RESULT_LIMIT)}\n…(结果过长已截断，完整 ${block.content.length} 字符)`
        : block.content;
      return `### 工具结果${block.isError ? "（错误）" : ""}\n\n${fence(body)}`;
    }
    case "image":
      return `[图片：${block.mediaType}]`;
  }
}

function renderMessage(message: ChatMessage): string {
  const body = message.content.map(renderBlock).join("\n\n");
  return `## ${ROLE_LABELS[message.role]} · ${message.createdAt}\n\n${body}`;
}

/** 会话导出为 Markdown：仅活动路径消息；thinking 折叠为 <details>；工具调用/结果为围栏代码块。 */
export function renderSessionMarkdown(detail: SessionDetail): string {
  // 标题中的换行会破坏 # 标题结构，压成空格
  const title = detail.title.replace(/\s+/g, " ").trim() || detail.id;
  const messages = activePathMessages(detail.messages, detail.activeLeafId);
  const parts = [
    `# ${title}`,
    `> ${detail.provider} · ${detail.model} · ${detail.createdAt} · ${detail.cwd}`,
    messages.length ? messages.map(renderMessage).join("\n\n") : "暂无消息",
    `---\n由 OpenWebCode 导出 · ${detail.id}`,
  ];
  return `${parts.join("\n\n")}\n`;
}
