/**
 * 子代理内部消息流：把 subagent 转录按主对话的阅读形态渲染成
 * 「任务 → 子代理正文/思考 → 工具调用 → 工具结果 → …」。
 *
 * 转录由 server 在每轮 provider 调用结束、每批工具结束后原子重写；
 * 运行中按固定间隔拉取，终态自动停止，因此刷新页面/重连后也能从转录恢复。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import type { ChatMessage, LiveSubagentRun, MessageContent } from "../lib/contracts";
import { formatTime } from "../lib/format";
import { summarizeToolInput } from "../lib/tool-format";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { useI18n } from "../i18n";
import { conclusionExcerpt } from "./SubagentRunCard";

const ROLE_LABELS: Record<ChatMessage["role"], [string, string]> = {
  user: ["任务", "Task"],
  assistant: ["子代理", "Subagent"],
  tool: ["工具", "Tool"],
};

/** 单条工具结果最大展示字符数：完整结果仍保留在转录文件中，界面只防极端输出撑爆 DOM。 */
const TOOL_RESULT_DISPLAY_LIMIT = 12_000;

function ThreadToolCall({ block }: { block: MessageContent }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(block.input);
  return (
    <details className="subagent-thread-tool" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="wrench" size={12} />
        <b className="mono">{block.name ?? "tool"}</b>
        {summary && <span className="subagent-thread-tool-summary mono" title={summary}>{summary}</span>}
        <span className="subagent-thread-tool-action">{t("参数", "Args")}</span>
      </summary>
      {open && Object.keys(block.input ?? {}).length > 0 && <pre className="mono">{JSON.stringify(block.input, null, 2)}</pre>}
    </details>
  );
}

function ThreadMedia({ media }: { media: NonNullable<MessageContent["media"]> | undefined }): ReactElement | null {
  const { t } = useI18n();
  const items = (media ?? []).filter((item) => typeof item.data === "string" && item.data.length > 0);
  if (items.length === 0) return null;
  return (
    <div className="tool-result-media">
      {items.map((item, index) => item.type === "image"
        ? <img key={index} className="tool-media-img" loading="lazy" src={`data:${item.mediaType ?? "image/png"};base64,${item.data}`} alt={t("工具结果图片", "Tool result image")} />
        : <video key={index} className="tool-media-video" controls preload="metadata" src={`data:${item.mediaType ?? "video/mp4"};base64,${item.data}`} />)}
    </div>
  );
}

function ThreadToolResult({ block }: { block: MessageContent }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const content = block.content ?? "";
  const truncated = content.length > TOOL_RESULT_DISPLAY_LIMIT
    ? `${content.slice(0, TOOL_RESULT_DISPLAY_LIMIT)}\n…`
    : content;
  return (
    <details
      className={`subagent-thread-tool subagent-thread-result${block.isError ? " error" : ""}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Icon name={block.isError ? "x" : "check"} size={12} />
        <b>{block.isError ? t("工具执行失败", "Tool failed") : t("工具结果", "Tool result")}</b>
        <span className="subagent-thread-tool-meta mono">{t(`${content.length} 字符`, `${content.length} chars`)}</span>
        <span className="subagent-thread-tool-action">{t("查看", "View")}</span>
      </summary>
      {open && truncated && <pre className="mono">{truncated}</pre>}
      {open && <ThreadMedia media={block.media} />}
    </details>
  );
}

function ThreadBlock({ block }: { block: MessageContent }): ReactElement | null {
  const { t } = useI18n();
  switch (block.type) {
    case "text":
      return block.text ? <Markdown>{block.text}</Markdown> : null;
    case "thinking":
      return block.text
        ? <details className="thinking"><summary>{t("思考过程", "Reasoning")}</summary><Markdown>{block.text}</Markdown></details>
        : null;
    case "tool_call":
      return <ThreadToolCall block={block} />;
    case "tool_result":
      return <ThreadToolResult block={block} />;
    case "web_search_call":
      return (
        <div className="subagent-thread-web-search">
          <Icon name="search" size={12} />
          <span>{t("联网搜索", "Web search")}</span>
          {block.status && <span className="mono">{block.status}</span>}
        </div>
      );
    case "image":
      return block.data
        ? <img className="message-image" src={`data:${block.mediaType ?? "image/png"};base64,${block.data}`} alt={t("工具结果图片", "Tool result image")} />
        : null;
    case "video":
      return block.data
        ? <video className="message-video" controls preload="metadata" src={`data:${block.mediaType ?? "video/mp4"};base64,${block.data}`} />
        : null;
    default:
      return null;
  }
}

function ThreadMessage({ message, agent }: { message: ChatMessage; agent: string | undefined }): ReactElement {
  const { t, locale } = useI18n();
  const [labelZh, labelEn] = ROLE_LABELS[message.role] ?? [message.role, message.role];
  const label = message.role === "assistant" && agent ? agent : t(labelZh, labelEn);
  const meta = (
    <div className="message-meta">
      {message.role !== "user" && <span className="message-author">{label}</span>}
      {message.createdAt && <time dateTime={message.createdAt}>{formatTime(message.createdAt, locale)}</time>}
    </div>
  );
  return (
    <article className={`message ${message.role} subagent-thread-message`} data-role={message.role}>
      {message.role !== "user" && meta}
      {message.content.map((block, index) => <ThreadBlock key={index} block={block} />)}
      {message.role === "user" && meta}
    </article>
  );
}

/**
 * 运行中的子代理消息流：初次打开即读转录，运行中每 1.2s 刷新；
 * 用户向上翻阅时暂停自动跟随，回到底部后恢复。
 */
export function SubagentThread({ sessionId, run }: { sessionId: string; run: LiveSubagentRun }): ReactElement {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const transcript = useQuery({
    queryKey: ["subagent-transcript", sessionId, run.taskId],
    queryFn: () => api.subagentTranscript(sessionId, run.taskId),
    retry: false,
    staleTime: 0,
    refetchInterval: run.status === "running" ? 1_200 : false,
  });
  const messages = transcript.data?.messages ?? [];
  const conclusion = transcript.data?.conclusion ?? "";
  // 首轮转录落盘前先用实时 started 事件里的 prompt 占位，打开标签立刻能看到任务。
  const pendingPrompt: ChatMessage | undefined = messages.length === 0 && run.prompt
    ? { id: `pending-${run.taskId}`, role: "user", content: [{ type: "text", text: run.prompt }], createdAt: "" }
    : undefined;
  const lastTextLength = messages.at(-1)?.content.reduce((sum, block) => sum + (block.text?.length ?? block.content?.length ?? 0), 0) ?? 0;
  // 进度文案从已持久化的消息形状推导：assistant 的 tool_call 还没有对应结果 → 工具执行中。
  const lastMessage = messages.at(-1);
  const resultIds = new Set(messages.flatMap((message) => message.content
    .filter((block) => block.type === "tool_result" && block.toolCallId)
    .map((block) => block.toolCallId!)));
  const hasUnfinishedTool = lastMessage?.role === "assistant"
    && lastMessage.content.some((block) => block.type === "tool_call" && block.id && !resultIds.has(block.id));
  const phaseLabel = hasUnfinishedTool
    ? t("工具执行中", "Running tools")
    : t("模型生成中", "Model generating");
  // 结论通常就是最后一条 assistant 正文：已在消息流里完整显示时不再重复摘要条。
  const lastAssistantText = [...messages].reverse()
    .find((message) => message.role === "assistant")
    ?.content.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  const conclusionAlreadyShown = Boolean(conclusion) && lastAssistantText === conclusion.trim();

  // 终态事件先于最后一次轮询到达时，补取一次终态转录（最终结论在 run 结束后才落盘）。
  const refetchTranscript = transcript.refetch;
  const previousStatusRef = useRef(run.status);
  useEffect(() => {
    if (previousStatusRef.current === "running" && run.status !== "running") void refetchTranscript();
    previousStatusRef.current = run.status;
  }, [run.status, refetchTranscript]);

  // 新轮次/新消息到达时，仅在用户仍停留在底部附近时跟随；否则保留阅读位置。
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, lastTextLength, run.turns, run.toolsUsed.length, transcript.data?.updatedAt, run.status]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const copyConclusion = (): void => {
    void writeClipboard(conclusion).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="subagent-thread-wrap">
      <div className="subagent-thread" ref={scrollRef} onScroll={onScroll} role="log" aria-label={t("子代理消息流", "Subagent message stream")}>
        {pendingPrompt && <ThreadMessage key={pendingPrompt.id} message={pendingPrompt} agent={run.agent} />}
        {messages.map((message) => <ThreadMessage key={message.id} message={message} agent={run.agent} />)}
        {transcript.isPending && messages.length === 0 && (
          <p className="subagent-thread-hint">{t("正在读取子代理消息…", "Loading subagent messages…")}</p>
        )}
        {transcript.isError && run.status === "running" && messages.length === 0 && (
          <p className="subagent-thread-hint">{t("等待子代理输出…", "Waiting for the subagent to produce output…")}</p>
        )}
        {transcript.isError && run.status !== "running" && messages.length === 0 && (
          <p className="panel-error" role="alert">{t("子代理转录加载失败", "Failed to load the subagent transcript")}</p>
        )}
        {!transcript.isPending && !transcript.isError && run.status !== "running" && messages.length === 0 && !conclusion && (
          <p className="subagent-thread-hint">{t("暂无消息记录。", "No messages recorded.")}</p>
        )}
        {run.status === "running" && (
          <div className="subagent-thread-running" role="status">
            <span className="subagent-run-pulse" aria-hidden />
            <span>{t(`第 ${run.turns} 轮 · ${phaseLabel}…`, `Turn ${run.turns} · ${phaseLabel}…`)}</span>
            {run.toolsUsed.length > 0 && <span className="mono">{t(`已用 ${run.toolsUsed.join(", ")}`, `Used ${run.toolsUsed.join(", ")}`)}</span>}
          </div>
        )}
        {run.status === "failed" && (
          <p className="subagent-thread-error" role="alert">{run.error ?? transcript.data?.error ?? t("子代理运行失败", "The subagent run failed")}</p>
        )}
        {run.status !== "running" && conclusion && (
          <div className={conclusionAlreadyShown ? "subagent-thread-conclusion-actions" : "subagent-transcript-summary"}>
            {!conclusionAlreadyShown && <p className="subagent-transcript-summary-text" title={conclusion}>{conclusionExcerpt(conclusion)}</p>}
            <button type="button" className="subagent-transcript-copy" onClick={copyConclusion}>
              {copied ? t("已复制", "Copied") : t("复制结论", "Copy conclusion")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
