import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import type { ChatMessage, ExtensionInfo, LiveSubagentRun, MessageContent } from "../lib/contracts";
import type { DiffSpec } from "./editor/DiffPane";
import { Icon } from "./Icon";
import { CodeBlock, Markdown } from "./Markdown";
import { SubagentRunCard } from "./SubagentRunCard";
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

/** 转录消息折叠阈值：超过后默认只展示最近 N 条（转录可能很长，不做虚拟化） */
const TRANSCRIPT_MESSAGE_FOLD = 20;

/** 转录消息内容的紧凑渲染：assistant 文本用 Markdown，工具调用/结果压缩为单行 */
function TranscriptBlock({ block }: { block: MessageContent }): ReactElement | null {
  const { t } = useI18n();
  switch (block.type) {
    case "text":
      return block.text ? <Markdown>{block.text}</Markdown> : null;
    case "tool_call": {
      const summary = summarizeToolInput(block.input);
      return (
        <p className="subagent-transcript-tool mono">
          <Icon name="wrench" size={11} /> {block.name ?? "tool"}{summary ? ` · ${summary}` : ""}
        </p>
      );
    }
    case "tool_result": {
      const text = block.content ?? "";
      const truncated = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      return (
        <details className="subagent-transcript-result">
          <summary>{block.isError ? t("工具结果（错误）", "Tool result (error)") : t("工具结果", "Tool result")}</summary>
          <pre className="mono">{truncated}</pre>
        </details>
      );
    }
    default:
      return null;
  }
}

const TRANSCRIPT_ROLE_LABELS: Record<string, [string, string]> = { user: ["任务", "Task"], assistant: ["子代理", "Subagent"], tool: ["工具", "Tool"] };

/** spawn_task/spawn_swarm 工具结果携带的子代理转录：展开时按 taskId 拉取，只读展示 */
export function SubagentTranscriptDetails({ sessionId, taskId, index }: { sessionId: string; taskId: string; index?: number | undefined }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 折叠超过 TRANSCRIPT_MESSAGE_FOLD 的历史消息；用户可手动展开全部
  const [showAll, setShowAll] = useState(false);
  const transcript = useQuery({
    queryKey: ["subagent-transcript", sessionId, taskId],
    queryFn: () => api.subagentTranscript(sessionId, taskId),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const label = index !== undefined
    ? t(`子代理转录 ${index}`, `Subagent transcript ${index}`)
    : t("子代理转录", "Subagent transcript");
  const messages = transcript.data?.messages ?? [];
  const hiddenCount = Math.max(0, messages.length - TRANSCRIPT_MESSAGE_FOLD);
  const shownMessages = hiddenCount > 0 && !showAll ? messages.slice(hiddenCount) : messages;
  return (
    <details className="subagent-transcript" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && transcript.isPending && <p className="subagent-transcript-status">{t("加载中…", "Loading…")}</p>}
      {open && transcript.isError && <p className="subagent-transcript-status">{t("转录加载失败", "Failed to load transcript")}</p>}
      {open && transcript.data && (
        <div className="subagent-transcript-body">
          <p className="subagent-transcript-meta mono">
            {[
              transcript.data.agent,
              t(`${transcript.data.turns} 轮`, `${transcript.data.turns} turns`),
              transcript.data.toolsUsed.length > 0 ? transcript.data.toolsUsed.join(", ") : undefined,
            ].filter(Boolean).join(" · ")}
          </p>
          <p className="subagent-transcript-prompt">{transcript.data.prompt}</p>
          <Markdown>{transcript.data.conclusion}</Markdown>
          {messages.length > 0 && (
            <details className="subagent-transcript-messages">
              <summary>{t(`消息记录（${messages.length} 条）`, `Messages (${messages.length})`)}</summary>
              {hiddenCount > 0 && (
                <p className="subagent-transcript-status">
                  {!showAll && t(`仅显示最近 ${TRANSCRIPT_MESSAGE_FOLD} 条，已折叠前 ${hiddenCount} 条`, `Showing the last ${TRANSCRIPT_MESSAGE_FOLD}; ${hiddenCount} earlier folded`)}
                  <button type="button" className="subagent-transcript-fold-toggle" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? t("收起", "Collapse") : t(`展开全部 ${messages.length} 条`, `Show all ${messages.length}`)}
                  </button>
                </p>
              )}
              {shownMessages.map((message) => (
                <div key={message.id} className={`subagent-transcript-message ${message.role}`}>
                  <span className="subagent-transcript-role">{TRANSCRIPT_ROLE_LABELS[message.role] ? t(...TRANSCRIPT_ROLE_LABELS[message.role]!) : message.role}</span>
                  {message.content.map((block, blockIndex) => <TranscriptBlock key={blockIndex} block={block} />)}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </details>
  );
}

export function ToolResultCard({ content, error, sessionId, subagentTaskIds }: { content: string; error: boolean; sessionId?: string | undefined; subagentTaskIds?: string[] | undefined }): ReactElement {
  const { t } = useI18n();
  const collapsible = error || content.length > 400 || content.includes("\n");
  const transcripts = sessionId && subagentTaskIds && subagentTaskIds.length > 0
    ? (
      <div className="subagent-transcripts">
        {subagentTaskIds.map((taskId, i) => (
          <SubagentTranscriptDetails key={taskId} sessionId={sessionId} taskId={taskId} index={subagentTaskIds.length > 1 ? i + 1 : undefined} />
        ))}
      </div>
    )
    : null;
  if (!collapsible) {
    return (
      <section className={`tool-result${error ? " error" : ""}`}>
        <span className="tool-result-label">{t("结果", "Result")}</span>
        <p className="mono">{content}</p>
        {transcripts}
      </section>
    );
  }
  return (
    <section className={`tool-result${error ? " error" : ""}`}>
      <details open={error}>
        <summary>{error ? t("执行失败", "Execution failed") : t(`执行结果（${content.length} 字符）`, `Result (${content.length} characters)`)}</summary>
        <pre className="mono">{content}</pre>
      </details>
      {transcripts}
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

function ContentBlock({ block, sessionId, liveSubagents, onOpenDiff }: { block: MessageContent; sessionId?: string | undefined; liveSubagents?: LiveSubagentRun[] | undefined; onOpenDiff?(spec: DiffSpec): void }): ReactElement | null {
  const { t } = useI18n();
  switch (block.type) {
    case "text":
      return <Markdown>{block.text ?? ""}</Markdown>;
    case "thinking":
      return <ThinkingBlock text={block.text ?? ""} />;
    case "tool_call": {
      // spawn_task/spawn_swarm 用专用卡片：运行中展示实时进度，历史卡片展示静态摘要
      if ((block.name === "spawn_task" || block.name === "spawn_swarm") && block.id) {
        const live = liveSubagents?.filter((run) => run.toolCallId === block.id);
        return <SubagentRunCard name={block.name} input={block.input} sessionId={sessionId} live={live} />;
      }
      return <ToolCallCard name={block.name ?? "tool"} input={block.input} onOpenDiff={onOpenDiff} />;
    }
    case "tool_result":
      return <ToolResultCard content={block.content ?? ""} error={Boolean(block.isError)} sessionId={sessionId} subagentTaskIds={block.subagentTaskIds} />;
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

export function MessageCard({ message, sessionId, turn, contentLens, liveSubagents, running = false, onNotice, onOpenDiff, onEditMessage, onRegenerate, onFork }: { message: ChatMessage; sessionId?: string; /** 轮次编号（user 消息开启一轮）：偶数/奇数轮 assistant/tool 消息底色深浅交替 */ turn?: number | undefined; contentLens?: ExtensionInfo; /** 本消息内 spawn 工具调用关联的实时子代理运行（已由 ExecutionTrack 按 toolCallId 过滤） */ liveSubagents?: LiveSubagentRun[] | undefined; /** 会话运行中：编辑重发/重新生成不可用（分叉允许） */ running?: boolean; onNotice?(message: string, kind?: "info" | "error"): void; onOpenDiff?(spec: DiffSpec): void; /** 会话树操作（仅 user 消息展示）：编辑重发 / 重新生成 / 分叉 */ onEditMessage?(message: ChatMessage): void; onRegenerate?(message: ChatMessage): void; onFork?(message: ChatMessage): void }): ReactElement {
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
    <article className={`message ${message.role}${turn !== undefined ? ` turn-${turn % 2 === 0 ? "even" : "odd"}` : ""}`} ref={articleRef} data-message-id={message.id}>
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
        {message.role === "user" && sessionId && text && onEditMessage && (
          <button
            className="copy-btn"
            disabled={running}
            title={running ? t("运行中不可用", "Unavailable while running") : t("编辑该消息并重新发送", "Edit this message and resend")}
            onClick={() => onEditMessage(message)}
          >
            <Icon name="edit" size={12} />
            {t("编辑重发", "Edit & resend")}
          </button>
        )}
        {message.role === "user" && sessionId && text && onRegenerate && (
          <button
            className="copy-btn"
            disabled={running}
            title={running ? t("运行中不可用", "Unavailable while running") : t("检出到该消息之前并重新生成回复", "Check out to before this message and regenerate the reply")}
            onClick={() => onRegenerate(message)}
          >
            <Icon name="history" size={12} />
            {t("重新生成", "Regenerate")}
          </button>
        )}
        {message.role === "user" && sessionId && onFork && (
          <button
            className="copy-btn"
            title={t("从该消息分叉为新会话", "Fork a new session from this message")}
            onClick={() => onFork(message)}
          >
            <Icon name="git" size={12} />
            {t("分叉", "Fork")}
          </button>
        )}
      </div>
      {content.map((block, index) => <ContentBlock key={index} block={block} sessionId={sessionId} liveSubagents={liveSubagents} onOpenDiff={onOpenDiff} />)}
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
  && previous.turn === next.turn
  && previous.running === next.running
  && previous.onNotice === next.onNotice
  && previous.onOpenDiff === next.onOpenDiff
  && previous.onEditMessage === next.onEditMessage
  && previous.onRegenerate === next.onRegenerate
  && previous.onFork === next.onFork
  // 实时子代理状态字段有限且不含函数，JSON 比较足够（仅含本消息相关条目，通常为空）
  && JSON.stringify(previous.liveSubagents ?? null) === JSON.stringify(next.liveSubagents ?? null)
  && previous.message.id === next.message.id
  && previous.message.role === next.message.role
  && previous.message.createdAt === next.message.createdAt
  && sameContent(previous.message.content, next.message.content),
);
