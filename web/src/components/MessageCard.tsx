import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { ChatMessage, ExtensionInfo, MessageContent } from "../lib/contracts";
import type { DiffSpec } from "./editor/DiffPane";
import { Icon } from "./Icon";
import { CodeBlock, Markdown } from "./Markdown";
import { useI18n } from "../i18n";

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

/** 从 write_file/edit_file 工具入参构造 diff 视图打开规格；非文件改动工具返回 undefined */
export function diffSpecForTool(name: string, input?: Record<string, unknown>): DiffSpec | undefined {
  const path = typeof input?.path === "string" ? input.path : undefined;
  if (!path) return undefined;
  if (name === "write_file") return { source: "agent-write", path, content: String(input?.content ?? "") };
  if (name === "edit_file") return { source: "agent-edit", path, oldText: String(input?.oldText ?? ""), newText: String(input?.newText ?? "") };
  return undefined;
}

export function ToolCallCard({ name, input, onOpenDiff }: { name: string; input?: Record<string, unknown>; onOpenDiff?(spec: DiffSpec): void }): ReactElement {
  const { t } = useI18n();
  const summary = summarizeToolInput(input);
  const json = JSON.stringify(input ?? {}, null, 2);
  const diffSpec = diffSpecForTool(name, input);
  return (
    <section className="tool-card">
      <header>
        <span className="tool-icon" aria-hidden><Icon name="wrench" size={13} /></span>
        <b className="mono">{name}</b>
        {diffSpec && onOpenDiff && (
          <button
            className="btn small tool-diff-open"
            onClick={() => onOpenDiff(diffSpec)}
            aria-label={t("在 diff 视图中打开该文件变化", "Open this file change in the diff view")}
          >
            {t("在 diff 中打开", "Open in diff")}
          </button>
        )}
      </header>
      {summary && <p className="tool-summary mono" title={summary}>{summary}</p>}
      {json !== "{}" && (
        <details className="tool-detail">
          <summary>{t("参数", "Parameters")}</summary>
          <CodeBlock lang="json" code={json} />
        </details>
      )}
    </section>
  );
}

export function ToolResultCard({ content, error }: { content: string; error: boolean }): ReactElement {
  const { t } = useI18n();
  const collapsible = error || content.length > 400 || content.includes("\n");
  if (!collapsible) {
    return (
      <section className={`tool-result${error ? " error" : ""}`}>
        <span className="tool-result-label">{t("结果", "Result")}</span>
        <p className="mono">{content}</p>
      </section>
    );
  }
  return (
    <section className={`tool-result${error ? " error" : ""}`}>
      <details open={error}>
        <summary>{error ? t("执行失败", "Execution failed") : t(`执行结果（${content.length} 字符）`, `Result (${content.length} characters)`)}</summary>
        <pre className="mono">{content}</pre>
      </details>
    </section>
  );
}

export function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }): ReactElement {
  const { t } = useI18n();
  return (
    <details className={`thinking${streaming ? " live" : ""}`}>
      <summary>{streaming ? t("正在思考", "Thinking") : t("思考过程", "Reasoning")}</summary>
      <Markdown>{text}</Markdown>
    </details>
  );
}

function ContentBlock({ block, onOpenDiff }: { block: MessageContent; onOpenDiff?(spec: DiffSpec): void }): ReactElement | null {
  const { t } = useI18n();
  switch (block.type) {
    case "text":
      return <Markdown>{block.text ?? ""}</Markdown>;
    case "thinking":
      return <ThinkingBlock text={block.text ?? ""} />;
    case "tool_call":
      return <ToolCallCard name={block.name ?? "tool"} input={block.input} onOpenDiff={onOpenDiff} />;
    case "tool_result":
      return <ToolResultCard content={block.content ?? ""} error={Boolean(block.isError)} />;
    case "image":
      return <img className="message-image" src={`data:${block.mediaType ?? "image/png"};base64,${block.data ?? ""}`} alt={t("用户上传的图片", "User-uploaded image")} />;
    default:
      return null;
  }
}

/** 兼容旧会话：历史版本会把 assistant 的每个流式分片保存成独立 text 块。 */
export function coalesceAssistantText(content: MessageContent[]): MessageContent[] {
  const result: MessageContent[] = [];
  for (const block of content) {
    const previous = result.at(-1);
    if (block.type === "text" && previous?.type === "text") {
      result[result.length - 1] = { ...previous, text: `${previous.text ?? ""}${block.text ?? ""}` };
    } else {
      result.push(block);
    }
  }
  return result;
}

const ROLE_LABELS: Record<string, [string, string]> = { user: ["你", "You"], assistant: ["OpenWebCode", "OpenWebCode"], tool: ["工具", "Tool"] };

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

export function MessageCard({ message, sessionId, contentLens, onNotice, onOpenDiff }: { message: ChatMessage; sessionId?: string; contentLens?: ExtensionInfo; onNotice?(message: string, kind?: "info" | "error"): void; onOpenDiff?(spec: DiffSpec): void }): ReactElement {
  const { t, locale } = useI18n();
  const createdAt = new Date(message.createdAt);
  const articleRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [lensBusy, setLensBusy] = useState(false);
  const [translation, setTranslation] = useState<string>();
  const [explanation, setExplanation] = useState<{ selection: string; text: string }>();
  const content = message.role === "assistant" ? coalesceAssistantText(message.content) : message.content;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  const targetLanguage = typeof contentLens?.config.targetLang === "string" ? contentLens.config.targetLang : "zh-CN";
  const rawTranslateConfig = contentLens?.config.translate;
  const translateConfig = rawTranslateConfig && typeof rawTranslateConfig === "object" && !Array.isArray(rawTranslateConfig)
    ? rawTranslateConfig as Record<string, unknown>
    : {};
  const translateMode = translateConfig.mode === "auto" || translateConfig.mode === "off" ? translateConfig.mode : "manual";
  const glossary = translateConfig.glossary && typeof translateConfig.glossary === "object" && !Array.isArray(translateConfig.glossary)
    ? translateConfig.glossary as Record<string, string>
    : undefined;
  const autoAttempted = useRef(false);

  useEffect(() => {
    if (translateMode !== "auto" || !contentLens?.enabled || !sessionId || !text || autoAttempted.current) return;
    autoAttempted.current = true;
    setLensBusy(true);
    api.translateMessage(sessionId, message.id, targetLanguage, glossary)
      .then((value) => setTranslation(value.text))
      .catch((error: unknown) => onNotice?.(error instanceof Error ? error.message : t("自动翻译失败", "Automatic translation failed"), "error"))
      .finally(() => setLensBusy(false));
  }, [contentLens?.enabled, glossary, message.id, onNotice, sessionId, targetLanguage, text, translateMode]);
  return (
    <article className={`message ${message.role}`} ref={articleRef}>
      <span className="track-node" aria-hidden />
      <div className="message-meta">
        <span className="message-author">{ROLE_LABELS[message.role] ? t(...ROLE_LABELS[message.role]!) : message.role}</span>
        <time dateTime={message.createdAt} title={createdAt.toLocaleString(locale)}>{createdAt.toLocaleTimeString(locale)}</time>
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
            {copied ? t("已复制", "Copied") : t("复制", "Copy")}
          </button>
        )}
        {text && sessionId && contentLens?.enabled && (
          <>
            {translateMode !== "off" && <button className="copy-btn" disabled={lensBusy} onClick={() => {
              setLensBusy(true);
              api.translateMessage(sessionId, message.id, targetLanguage, glossary)
                .then((value) => setTranslation(value.text))
                .catch((error: unknown) => onNotice?.(error instanceof Error ? error.message : t("翻译失败", "Translation failed"), "error"))
                .finally(() => setLensBusy(false));
            }}>{translateMode === "auto" && translation ? t("重译", "Translate again") : t("译", "Translate")}</button>}
            <button className="copy-btn" disabled={lensBusy} title={t("先在本条消息中选择不超过 200 字符", "Select up to 200 characters in this message first")} onClick={() => {
              const selection = window.getSelection();
              const selected = selection?.toString().trim() ?? "";
              if (!selected || selected.length > 200 || !articleRef.current?.contains(selection?.anchorNode ?? null) || !articleRef.current?.contains(selection?.focusNode ?? null)) {
                onNotice?.(t("请先在本条消息中选择 1–200 个字符", "Select 1–200 characters in this message first"), "error"); return;
              }
              setLensBusy(true);
              api.explainSelection(sessionId, selected, targetLanguage)
                .then((value) => setExplanation({ selection: selected, text: value.text }))
                .catch((error: unknown) => onNotice?.(error instanceof Error ? error.message : t("解析失败", "Explanation failed"), "error"))
                .finally(() => setLensBusy(false));
            }}>{t("解析选中", "Explain selection")}</button>
          </>
        )}
      </div>
      {content.map((block, index) => <ContentBlock key={index} block={block} onOpenDiff={onOpenDiff} />)}
      {translation && <details className="content-lens-result" open><summary>{t("译文", "Translation")}</summary><Markdown>{translation}</Markdown></details>}
      {explanation && <details className="content-lens-result" open><summary>{t("解析：", "Explanation: ")}{explanation.selection}</summary><Markdown>{explanation.text}</Markdown></details>}
    </article>
  );
}

/** 内容块逐项相等（不含未知字段时退化为引用比较之外的浅比较） */
function sameContent(previous: MessageContent[], next: MessageContent[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  // 消息块字段有限且不含函数，序列化比较足够且实现简单
  return JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Historical cards do not depend on live token state, so skip their Markdown/KaTeX work during streaming renders.
 * 自定义比较：事件重放/会话刷新会重建消息对象（引用不同但 id 与内容相同），
 * 此时不重复渲染，Markdown 与代码高亮结果随之复用。
 */
export const MemoMessageCard = memo(MessageCard, (previous, next) =>
  previous.contentLens === next.contentLens
  && previous.sessionId === next.sessionId
  && previous.onNotice === next.onNotice
  && previous.onOpenDiff === next.onOpenDiff
  && previous.message.id === next.message.id
  && previous.message.role === next.message.role
  && previous.message.createdAt === next.message.createdAt
  && sameContent(previous.message.content, next.message.content),
);
