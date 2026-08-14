import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { groupContentBlocks } from "../lib/content-groups";
import { formatToolContent } from "../lib/tool-format";
import { toolResultOf } from "../lib/shell-messages";
import type { LiveSubagentRun, MessageContent } from "../lib/contracts";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { useI18n } from "../i18n";
import { useChatActions, type MessageCardProps } from "./types";
import { groupCallsFromBlocks, ToolCallGroupRow, ToolCallListGroup } from "./ToolCallGroups";
import { SubagentRunCard, SubagentTranscriptDetails } from "./SubagentRunCard";

/** 工具调用终态（由配对的 tool_result 推导；无结果且会话运行中为 running）。 */
export type ToolCallStatus = "running" | "done" | "error";

/** 思考块：历史默认折叠（思考过程），流式中 live 态（正在思考 + 省略号呼吸） */
export function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }): ReactElement {
  const { t } = useI18n();
  return (
    <details className={`thinking${streaming ? " live" : ""}`}>
      <summary>{streaming ? t("正在思考", "Thinking") : t("思考过程", "Reasoning")}</summary>
      <Markdown>{text}</Markdown>
    </details>
  );
}

/** 孤立 tool_result（无配对调用成组时）：单行折叠结果卡；携带子代理转录时展开区内附转录查看器 */
function ToolResultCard({ block, sessionId }: { block: MessageContent; sessionId: string }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const error = Boolean(block.isError);
  const content = block.content ?? "";
  const formatted = error ? undefined : formatToolContent(content);
  const body = formatted ? formatted.body : content;
  const summary = formatted?.summary;
  const toggle = (): void => setOpen((value) => !value);
  return (
    <section className={`tool-row tool-result-row${open ? " open" : ""}${error ? " error" : ""}`}>
      <div
        className="collapse-row tool-row-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
      >
        <span className={`tool-row-status ${error ? "error" : "done"}`} aria-hidden>
          <Icon name={error ? "x" : "check"} size={12} />
        </span>
        <b className="tool-row-name">{error ? t("执行失败", "Execution failed") : t("执行结果", "Result")}</b>
        {summary
          ? <span className="tool-row-summary mono" title={summary}>{summary}</span>
          : !error && <span className="tool-row-summary mono">{t(`${body.length} 字符`, `${body.length} characters`)}</span>}
        <span className="tool-row-actions">
          <button type="button" className="tool-row-view" onClick={(event) => { event.stopPropagation(); toggle(); }}>{t("查看", "View")}</button>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </div>
      {open && (
        <div className="tool-row-body">
          <pre className="mono">{body || summary || content}</pre>
          {block.subagentTaskIds && block.subagentTaskIds.length > 0 && (
            <div className="subagent-transcripts">
              {block.subagentTaskIds.map((taskId, index) => (
                <SubagentTranscriptDetails key={taskId} sessionId={sessionId} taskId={taskId} index={block.subagentTaskIds!.length > 1 ? index + 1 : undefined} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 单块渲染：text/thinking/image 原位；tool_call 区分 spawn 专用卡与普通调用行；tool_result 孤立结果卡 */
function ContentBlock({ block, toolResults, liveSubagents }: {
  block: MessageContent;
  toolResults: Record<string, boolean>;
  liveSubagents?: LiveSubagentRun[] | undefined;
}): ReactElement | null {
  const { t } = useI18n();
  const { sessionId, running } = useChatActions();
  switch (block.type) {
    case "text":
      return <Markdown>{block.text ?? ""}</Markdown>;
    case "thinking":
      return <ThinkingBlock text={block.text ?? ""} />;
    case "tool_call": {
      // spawn_task/spawn_swarm 用专用卡片：运行中展示实时进度，历史卡片展示静态摘要
      if ((block.name === "spawn_task" || block.name === "spawn_swarm") && block.id) {
        const live = liveSubagents?.filter((run) => run.toolCallId === block.id);
        return <SubagentRunCard name={block.name} input={block.input} sessionId={sessionId} {...(live ? { live } : {})} />;
      }
      const call = groupCallsFromBlocks([block], toolResults, running)[0];
      return call ? <ToolCallGroupRow call={call} /> : null;
    }
    case "tool_result":
      return <ToolResultCard block={block} sessionId={sessionId} />;
    case "image":
      return <img className="message-image" src={`data:${block.mediaType ?? "image/png"};base64,${block.data ?? ""}`} alt={t("用户上传的图片", "User-uploaded image")} />;
    default:
      return null;
  }
}

/** 兼容旧会话：历史版本会把 assistant 的每个流式分片保存成独立 text 块。 */
function coalesceAssistantText(content: MessageContent[]): MessageContent[] {
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

export function MessageCard({ message, turn, toolResults, liveSubagents, shellCmd }: MessageCardProps): ReactElement {
  const { t, locale } = useI18n();
  const actions = useChatActions();
  const { sessionId, running, contentLens } = actions;
  const createdAt = new Date(message.createdAt);
  const articleRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
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
    if (translateMode !== "auto" || !contentLens?.enabled || !text || autoAttempted.current) return;
    autoAttempted.current = true;
    setLensBusy(true);
    api.translateMessage(sessionId, message.id, targetLanguage, glossary)
      .then((value) => setTranslation(value.text))
      .catch((error: unknown) => actions.onNotice(error instanceof Error ? error.message : t("自动翻译失败", "Automatic translation failed"), "error"))
      .finally(() => setLensBusy(false));
    // actions 引用由 ChatView 维持稳定；glossary 派生自 contentLens.config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentLens?.enabled, message.id, sessionId, targetLanguage, text, translateMode]);

  // 元信息行：assistant/tool 在正文上方；user 放到气泡外下方（右对齐，hover/触屏显示）
  const meta = (
    <div className="message-meta">
      {message.role !== "user" && <span className="message-author">{ROLE_LABELS[message.role] ? t(...ROLE_LABELS[message.role]!) : message.role}</span>}
      <time dateTime={message.createdAt} title={createdAt.toLocaleString(locale)}>{createdAt.toLocaleTimeString(locale)}</time>
      {text && (
        <button
          className="copy-btn"
          onClick={() => {
            void writeClipboard(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
              copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? t("已复制", "Copied") : t("复制", "Copy")}
        </button>
      )}
      {text && contentLens?.enabled && (
        <>
          {translateMode !== "off" && <button className="copy-btn" disabled={lensBusy} onClick={() => {
            setLensBusy(true);
            api.translateMessage(sessionId, message.id, targetLanguage, glossary)
              .then((value) => setTranslation(value.text))
              .catch((error: unknown) => actions.onNotice(error instanceof Error ? error.message : t("翻译失败", "Translation failed"), "error"))
              .finally(() => setLensBusy(false));
          }}>{translateMode === "auto" && translation ? t("重译", "Translate again") : t("译", "Translate")}</button>}
          <button className="copy-btn" disabled={lensBusy} title={t("先在本条消息中选择不超过 200 字符", "Select up to 200 characters in this message first")} onClick={() => {
            const selection = window.getSelection();
            const selected = selection?.toString().trim() ?? "";
            if (!selected || selected.length > 200 || !articleRef.current?.contains(selection?.anchorNode ?? null) || !articleRef.current?.contains(selection?.focusNode ?? null)) {
              actions.onNotice(t("请先在本条消息中选择 1–200 个字符", "Select 1–200 characters in this message first"), "error"); return;
            }
            setLensBusy(true);
            api.explainSelection(sessionId, selected, targetLanguage)
              .then((value) => setExplanation({ selection: selected, text: value.text }))
              .catch((error: unknown) => actions.onNotice(error instanceof Error ? error.message : t("解析失败", "Explanation failed"), "error"))
              .finally(() => setLensBusy(false));
          }}>{t("解析选中", "Explain selection")}</button>
        </>
      )}
      {message.role === "user" && text && (
        <button
          className="copy-btn"
          disabled={running}
          title={running ? t("运行中不可用", "Unavailable while running") : t("编辑该消息并重新发送", "Edit this message and resend")}
          onClick={() => actions.onEditMessage(message)}
        >
          <Icon name="edit" size={12} />
          {t("编辑重发", "Edit & resend")}
        </button>
      )}
      {message.role === "user" && text && (
        <button
          className="copy-btn"
          disabled={running}
          title={running ? t("运行中不可用", "Unavailable while running") : t("检出到该消息之前并重新生成回复", "Check out to before this message and regenerate the reply")}
          onClick={() => actions.onRegenerate(message)}
        >
          <Icon name="history" size={12} />
          {t("重新生成", "Regenerate")}
        </button>
      )}
      {message.role === "user" && (
        <button
          className="copy-btn"
          title={t("从该消息分叉为新会话", "Fork a new session from this message")}
          onClick={() => actions.onFork(message)}
        >
          <Icon name="git" size={12} />
          {t("分叉", "Fork")}
        </button>
      )}
    </div>
  );
  return (
    <article className={`message ${message.role} turn-${turn % 2 === 0 ? "even" : "odd"}`} ref={articleRef} data-message-id={message.id}>
      {message.role !== "user" && meta}
      {groupContentBlocks(content).map((group, index) => group.kind === "tool-group"
        ? <ToolCallListGroup key={index} calls={groupCallsFromBlocks(group.blocks, toolResults, running)} />
        : <ContentBlock key={index} block={group.block} toolResults={toolResults} liveSubagents={liveSubagents} />)}
      {translation && <details className="content-lens-result" open><summary>{t("译文", "Translation")}</summary><Markdown>{translation}</Markdown></details>}
      {explanation && <details className="content-lens-result" open><summary>{t("解析：", "Explanation: ")}{explanation.selection}</summary><Markdown>{explanation.text}</Markdown></details>}
      {shellCmd !== undefined && (
        // shell 结果卡「发给 agent」：命令文本由列表按序配对前一条 user `!cmd` 消息得出
        <button
          className="send-to-agent"
          onClick={() => actions.onSendToAgent(shellCmd, toolResultOf(message))}
        >
          <Icon name="send" size={11} /> {t("发给 agent", "Send to agent")}
        </button>
      )}
      {message.role === "user" && meta}
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
 * 历史卡片不依赖实时 token 状态，流式期间跳过其 Markdown/KaTeX 重渲染。
 * 自定义比较：事件重放/会话刷新会重建消息对象（引用不同但 id 与内容相同），
 * 此时不重复渲染，Markdown 与代码高亮结果随之复用。
 * 注意：ChatActions 经 context 消费，context 变化（如 running 翻转）不受 memo 阻断。
 */
export const MemoMessageCard = memo(MessageCard, (previous, next) =>
  previous.turn === next.turn
  && previous.shellCmd === next.shellCmd
  // 配对表由消息列表用 useMemo 维护，引用变化即内容变化
  && previous.toolResults === next.toolResults
  // 实时子代理状态字段有限且不含函数，JSON 比较足够（仅含本消息相关条目，通常为空）
  && JSON.stringify(previous.liveSubagents ?? null) === JSON.stringify(next.liveSubagents ?? null)
  && previous.message.id === next.message.id
  && previous.message.role === next.message.role
  && previous.message.createdAt === next.message.createdAt
  && sameContent(previous.message.content, next.message.content),
);
