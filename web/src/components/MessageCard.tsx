import { useState, type ReactElement } from "react";
import type { ChatMessage, MessageContent } from "../lib/contracts";
import { Icon } from "./Icon";
import { CodeBlock, Markdown } from "./Markdown";

const TOOL_SUMMARY_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "cwd"];

/** 从工具入参中提取最具辨识度的一项（命令/路径等）作为摘要 */
export function summarizeToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function ToolCallCard({ name, input }: { name: string; input?: Record<string, unknown> }): ReactElement {
  const summary = summarizeToolInput(input);
  const json = JSON.stringify(input ?? {}, null, 2);
  return (
    <section className="tool-card">
      <header>
        <span className="tool-icon" aria-hidden><Icon name="wrench" size={13} /></span>
        <b className="mono">{name}</b>
      </header>
      {summary && <p className="tool-summary mono" title={summary}>{summary}</p>}
      {json !== "{}" && (
        <details className="tool-detail">
          <summary>参数</summary>
          <CodeBlock lang="json" code={json} />
        </details>
      )}
    </section>
  );
}

export function ToolResultCard({ content, error }: { content: string; error: boolean }): ReactElement {
  const collapsible = error || content.length > 400 || content.includes("\n");
  if (!collapsible) {
    return (
      <section className={`tool-result${error ? " error" : ""}`}>
        <span className="tool-result-label">结果</span>
        <p className="mono">{content}</p>
      </section>
    );
  }
  return (
    <section className={`tool-result${error ? " error" : ""}`}>
      <details open={error}>
        <summary>{error ? "执行失败" : `执行结果（${content.length} 字符）`}</summary>
        <pre className="mono">{content}</pre>
      </details>
    </section>
  );
}

function ThinkingBlock({ text }: { text: string }): ReactElement {
  return (
    <details className="thinking">
      <summary>思考过程</summary>
      <pre>{text}</pre>
    </details>
  );
}

function ContentBlock({ block }: { block: MessageContent }): ReactElement | null {
  switch (block.type) {
    case "text":
      return <Markdown>{block.text ?? ""}</Markdown>;
    case "thinking":
      return <ThinkingBlock text={block.text ?? ""} />;
    case "tool_call":
      return <ToolCallCard name={block.name ?? "tool"} input={block.input} />;
    case "tool_result":
      return <ToolResultCard content={block.content ?? ""} error={Boolean(block.isError)} />;
    case "image":
      return <img className="message-image" src={`data:${block.mediaType ?? "image/png"};base64,${block.data ?? ""}`} alt="用户上传的图片" />;
    default:
      return null;
  }
}

const ROLE_LABELS: Record<string, string> = { user: "你", assistant: "OpenWebCode", tool: "工具" };

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到 execCommand
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export function MessageCard({ message }: { message: ChatMessage }): ReactElement {
  const createdAt = new Date(message.createdAt);
  const [copied, setCopied] = useState(false);
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  return (
    <article className={`message ${message.role}`}>
      <span className="track-node" aria-hidden />
      <div className="message-meta">
        <span className="message-author">{ROLE_LABELS[message.role] ?? message.role}</span>
        <time dateTime={message.createdAt} title={createdAt.toLocaleString()}>{createdAt.toLocaleTimeString()}</time>
        {text && (
          <button
            className="copy-btn"
            onClick={() => {
              void writeClipboard(text).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={12} />
            {copied ? "已复制" : "复制"}
          </button>
        )}
      </div>
      {message.content.map((block, index) => <ContentBlock key={index} block={block} />)}
    </article>
  );
}
