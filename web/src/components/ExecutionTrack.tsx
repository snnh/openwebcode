import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { AgentErrorPayload, ChatMessage, ExtensionInfo, LiveSubagentRun, SessionDetail } from "../lib/contracts";
import { agentErrorGuidance } from "../lib/agent-error";
import { shellCommandOf, toolResultOf } from "../lib/shell-messages";
import type { DiffSpec } from "./editor/DiffPane";
import { Icon } from "./Icon";
import { LiveActivity } from "./LiveActivity";
import type { LiveActivityInfo } from "../hooks/use-live-activity";
import { Markdown } from "./Markdown";
import { MemoMessageCard, ThinkingBlock } from "./MessageCard";
import { CONVERSATION_SEARCH_EVENT, ConversationSearch, findMatches, highlightArticle, unwrapSearchMarks } from "./ConversationSearch";
import { PermissionCard, type PermissionRequest } from "./PermissionCard";
import { useI18n } from "../i18n";

const VIRTUALIZE_AFTER = 80;
const ESTIMATED_MESSAGE_HEIGHT = 180;
const OVERSCAN_PX = 900;

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function MeasuredItem({ index, onHeight, children }: { index: number; onHeight(index: number, height: number): void; children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const report = (): void => onHeight(index, Math.ceil(element.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, onHeight]);
  return <div className="virtual-message-item" ref={ref}>{children}</div>;
}

/** 提取消息内 spawn_task/spawn_swarm 工具调用关联的实时子代理运行（无则 undefined，保持 memo 稳定） */
function liveRunsForMessage(message: ChatMessage, liveSubagents?: Record<string, LiveSubagentRun>): LiveSubagentRun[] | undefined {
  if (!liveSubagents) return undefined;
  const callIds = new Set(
    message.content
      .filter((block) => block.type === "tool_call" && (block.name === "spawn_task" || block.name === "spawn_swarm"))
      .map((block) => block.id),
  );
  if (callIds.size === 0) return undefined;
  const runs = Object.values(liveSubagents).filter((run) => callIds.has(run.toolCallId));
  return runs.length > 0 ? runs : undefined;
}

export function ExecutionTrack({ session, cleared, streamText, thinkingText, runError, permissions, onPermissionDone, onPermissionError, onSendToAgent, contentLens, onNotice, onOpenDiff, onOpenSettings, onRetryRun, retryPending, hasMoreMessages, onLoadMore, loadingMore, liveSubagents, liveActivity, trackVisible = true, running = false, onEditMessage, onRegenerate, onFork }: {
  session: SessionDetail;
  cleared?: { uptoIndex: number; at: string };
  streamText: string;
  thinkingText?: string;
  /** 服务端本轮在工具/Provider/运行基础设施上失败时的持久可见说明（含分类 kind 与 retryable）。 */
  runError?: AgentErrorPayload;
  permissions: PermissionRequest[];
  onPermissionDone(requestId: string): void;
  onPermissionError?(message: string): void;
  onSendToAgent?(cmd: string, output: string): void;
  contentLens?: ExtensionInfo;
  onNotice?(message: string, kind?: "info" | "error"): void;
  /** 0.5.0 Phase 1b：write_file/edit_file 工具卡的文件变化一键在统一 diff 视图打开 */
  onOpenDiff?(spec: DiffSpec): void;
  /** 错误卡深链：打开设置对话框的指定页签 */
  onOpenSettings?(tab: "models"): void;
  /** 错误卡「重试」：重发本会话最近一条用户消息（仅会话空闲且存在用户消息时下发） */
  onRetryRun?(): void;
  /** 重试发送进行中（发送 mutation pending）：禁用重试按钮防止双击重发 */
  retryPending?: boolean;
  /** 0.5.0 Phase 2：历史消息分页——是否有更早的消息可加载 */
  hasMoreMessages?: boolean;
  /** 0.5.0 Phase 2：加载更早消息的回调 */
  onLoadMore?(): void;
  /** 0.5.0 Phase 2：加载中状态 */
  loadingMore?: boolean;
  /** 本会话子代理实时运行状态（taskId → run），按消息内 spawn 工具调用的 toolCallId 过滤下发 */
  liveSubagents?: Record<string, LiveSubagentRun>;
  /** 对话面板是否可见（子代理标签选中时容器为 hidden）：不可见时暂停吸底滚动，恢复可见时重新贴底 */
  trackVisible?: boolean;
  /** 实时活动（agent.state + 未结束工具）：有值时在滚动区底部渲染吸底活动条 */
  liveActivity?: LiveActivityInfo | undefined;
  /** 会话运行中：用户消息的编辑重发/重新生成按钮禁用（分叉允许） */
  running?: boolean;
  /** 会话树操作：编辑重发 / 重新生成 / 分叉（仅 user 消息卡片使用） */
  onEditMessage?(message: ChatMessage): void;
  onRegenerate?(message: ChatMessage): void;
  onFork?(message: ChatMessage): void;
}): ReactElement {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  // 用户位于底部附近时新内容自动贴底；上翻阅读时不打扰
  const [pinned, setPinned] = useState(true);
  const heights = useRef(new Map<string, number>());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const virtual = session.messages.length > VIRTUALIZE_AFTER;
  const offsets = useMemo(() => {
    const values = [0];
    for (const message of session.messages) values.push(values.at(-1)! + (heights.current.get(message.id) ?? ESTIMATED_MESSAGE_HEIGHT));
    return values;
  }, [layoutVersion, session.messages]);
  const totalMessageHeight = offsets.at(-1) ?? 0;
  const [firstVisible, lastVisible] = useMemo(() => {
    if (!virtual) return [0, session.messages.length] as const;
    const start = Math.max(0, upperBound(offsets, Math.max(0, viewport.top - OVERSCAN_PX)) - 1);
    const end = Math.min(session.messages.length, upperBound(offsets, viewport.top + viewport.height + OVERSCAN_PX) + 1);
    return [start, end] as const;
  }, [offsets, session.messages.length, viewport, virtual]);
  const measure = useCallback((index: number, height: number): void => {
    const id = session.messages[index]?.id;
    if (!id || height < 1 || heights.current.get(id) === height) return;
    heights.current.set(id, height);
    setLayoutVersion((value) => value + 1);
  }, [session.messages]);

  // 轮次编号：一条 user 消息开启一轮，其后的 assistant/tool 归属该轮（首条 user 前为 0），用于轮次深浅底色
  const turnOf = useMemo(() => {
    const values: number[] = [];
    let turn = 0;
    for (const message of session.messages) {
      if (message.role === "user") turn += 1;
      values.push(turn);
    }
    return values;
  }, [session.messages]);

  // ===== 会话内搜索（Ctrl+F）：状态留在本层，与消息/滚动容器同层 =====
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);

  // 命令动作经 window 事件打开（命令体系不感知 React 状态；已打开时递增 focusSignal 重新聚焦）
  useEffect(() => {
    const open = (): void => {
      setSearchOpen(true);
      setFocusSignal((value) => value + 1);
    };
    window.addEventListener(CONVERSATION_SEARCH_EVENT, open);
    return () => window.removeEventListener(CONVERSATION_SEARCH_EVENT, open);
  }, []);

  // 切换会话时重置搜索
  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
    setActiveMatch(0);
  }, [session.id]);

  const matches = useMemo(() => findMatches(session.messages, query), [session.messages, query]);
  const currentMatch = matches.length === 0 ? 0 : Math.min(activeMatch, matches.length - 1);

  // 高亮：不动 React 渲染，layout effect 内对文本节点包/拆 <mark>。
  // MutationObserver 兜底：Markdown 懒加载换壳（fallback 纯文本 → 渲染树）或虚拟化
  // 挂载新文章时重挂高亮；自身包/拆 mark 的变动被过滤，不会自激。
  // scrollIntoView 仅在「查询或当前命中变化」时执行（scrollKeyRef 去重），用户手动滚动不被拽回。
  const scrollKeyRef = useRef("");
  useLayoutEffect(() => {
    const root = trackRef.current;
    if (!root) return;
    const applyHighlights = (): void => {
      unwrapSearchMarks(root);
      for (const element of Array.from(root.querySelectorAll(".conv-search-active"))) element.classList.remove("conv-search-active");
      if (!searchOpen || !query || matches.length === 0) return;
      const articleByMessageId = new Map<string, Element>();
      for (const element of Array.from(root.querySelectorAll("article[data-message-id]"))) {
        const id = element.getAttribute("data-message-id");
        if (id) articleByMessageId.set(id, element);
      }
      const active = matches[currentMatch];
      const activeByMessage = new Map<string, number>();
      for (const match of matches) if (!activeByMessage.has(match.messageId)) activeByMessage.set(match.messageId, -1);
      if (active) activeByMessage.set(active.messageId, active.occurrence);
      for (const [messageId, activeOccurrence] of activeByMessage) {
        const article = articleByMessageId.get(messageId);
        if (!article) continue;
        highlightArticle(article, query, activeOccurrence);
        if (activeOccurrence >= 0) article.classList.add("conv-search-active");
      }
    };
    applyHighlights();
    if (!searchOpen || !query || matches.length === 0) return;
    const active = matches[currentMatch];
    if (active) {
      const scrollKey = `${query}#${currentMatch}`;
      if (scrollKeyRef.current !== scrollKey) {
        scrollKeyRef.current = scrollKey;
        const target = root.querySelector(`article[data-message-id="${active.messageId}"]`);
        if (target) {
          // jsdom 无 scrollIntoView，测试环境跳过
          if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
        } else {
          // 虚拟化未挂载：先按估算偏移跳滚动，挂载后 observer/依赖变化补高亮
          const index = session.messages.findIndex((message) => message.id === active.messageId);
          if (index >= 0 && (index < firstVisible || index >= lastVisible)) {
            root.scrollTop = Math.max(0, (offsets[index] ?? 0) - viewport.height / 2);
          }
        }
      }
    }
    const observer = new MutationObserver((records) => {
      const foreign = records.some((record) =>
        Array.from(record.addedNodes).some((node) => node instanceof HTMLElement && !node.matches("mark.conv-search-hit")));
      if (foreign) applyHighlights();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [searchOpen, query, matches, currentMatch, firstVisible, lastVisible, offsets, viewport.height, session.messages]);

  // jsdom 无 Element.scrollTo，测试环境回退到 scrollTop
  const scrollToBottom = (smooth = false): void => {
    const element = trackRef.current;
    // 容器无布局（如对话面板 hidden 时 display:none）：跳过，避免 scrollHeight===0 重置滚动位置
    if (!element || element.clientHeight === 0) return;
    if (smooth && typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    setViewport({ top: Math.max(0, element.scrollHeight - element.clientHeight), height: element.clientHeight || 800 });
  };

  useEffect(() => {
    // 面板隐藏时暂停吸底；trackVisible 翻回 true 时本 effect 重跑，pinned 状态下重新贴底
    if (!pinned || !trackVisible) return;
    scrollToBottom();
  }, [pinned, trackVisible, session.messages.length, streamText, thinkingText, permissions.length]);

  return (
    <div className="execution-track-wrap">
      <div
        className="execution-track"
        ref={trackRef}
        onScroll={() => {
          const element = trackRef.current;
          if (element) {
            setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
            setViewport({ top: element.scrollTop, height: element.clientHeight || 800 });
          }
        }}
      >
        {hasMoreMessages && onLoadMore && (
          <div className="load-more-bar">
            <button className="load-more-btn" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? t("加载中…", "Loading…") : t("加载更早的消息", "Load earlier messages")}
            </button>
          </div>
        )}
        {session.messages.length === 0 && !streamText && (
          <p className="track-empty">{t("还没有消息。在下方描述要完成的任务，开始第一项作业。", "No messages yet. Describe a task below to start your first job.")}</p>
        )}
        {virtual && <div aria-hidden style={{ height: offsets[firstVisible] ?? 0 }} />}
        {session.messages.slice(firstVisible, lastVisible).map((message, relativeIndex) => {
          const index = firstVisible + relativeIndex;
          // shell 快捷命令的结果卡（user `!cmd` + tool_result 配对）附「发给 agent」按钮
          const shellCmd = message.role === "tool" ? shellCommandOf(session.messages[index - 1]) : undefined;
          const item = (
            <Fragment key={message.id}>
              {cleared && Math.min(cleared.uptoIndex, session.messages.length) === index && (
                <div className="context-cleared-divider" role="separator">{t("上下文已清空（历史保留）", "Context cleared (history retained)")}</div>
              )}
              <MemoMessageCard message={message} sessionId={session.id} turn={turnOf[index]} contentLens={contentLens} liveSubagents={liveRunsForMessage(message, liveSubagents)} running={running} onNotice={onNotice} onOpenDiff={onOpenDiff} onEditMessage={onEditMessage} onRegenerate={onRegenerate} onFork={onFork} />
              {shellCmd && onSendToAgent && (
                <button
                  className="send-to-agent"
                  onClick={() => onSendToAgent(shellCmd, toolResultOf(message))}
                >
                  <Icon name="send" size={11} /> {t("发给 agent", "Send to agent")}
                </button>
              )}
            </Fragment>
          );
          return virtual ? <MeasuredItem key={message.id} index={index} onHeight={measure}>{item}</MeasuredItem> : item;
        })}
        {virtual && <div aria-hidden style={{ height: Math.max(0, totalMessageHeight - (offsets[lastVisible] ?? totalMessageHeight)) }} />}
        {cleared && Math.min(cleared.uptoIndex, session.messages.length) === session.messages.length && (
          <div className="context-cleared-divider" role="separator">{t("上下文已清空（历史保留）", "Context cleared (history retained)")}</div>
        )}
        {runError && (() => {
          const guidance = agentErrorGuidance(runError, t);
          // 原始错误保留可见但弱化：超长 JSON blob 默认折叠
          const longMessage = runError.message.length > 280;
          return (
            <section className="tool-result error run-error" role="alert">
              <span className="tool-result-label">{t("本轮执行失败", "Run failed")}</span>
              {guidance.hint && <p className="run-error-hint">{guidance.hint}</p>}
              {longMessage ? (
                <details className="run-error-details">
                  <summary>{t("原始错误信息", "Raw error message")}</summary>
                  <pre className="mono">{runError.message}</pre>
                </details>
              ) : (
                <pre className="mono run-error-message">{runError.message}</pre>
              )}
              {(guidance.settingsTab || (guidance.retryable && onRetryRun)) && (
                <div className="run-error-actions">
                  {guidance.settingsTab && (
                    <button type="button" className="btn small" onClick={() => onOpenSettings?.(guidance.settingsTab!)}>
                      {t("打开模型设置", "Open model settings")}
                    </button>
                  )}
                  {guidance.retryable && onRetryRun && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={retryPending}
                      title={t("重发最近一条用户消息；附件不随重试重发", "Resends the latest user message; attachments are not re-sent")}
                      onClick={onRetryRun}
                    >{t("重试", "Retry")}</button>
                  )}
                </div>
              )}
            </section>
          );
        })()}
        {(streamText || thinkingText) && (
          <article className={`message assistant live turn-${(turnOf.at(-1) ?? 0) % 2 === 0 ? "even" : "odd"}`}>
            <span className="track-node" aria-hidden />
            <div className="message-meta">
              <span className="message-author">OpenWebCode</span>
              <span>{t("正在输出", "Responding")}</span>
            </div>
            {thinkingText && <ThinkingBlock text={thinkingText} streaming />}
            {streamText && <Markdown>{streamText}</Markdown>}
            <span className="cursor" aria-hidden />
          </article>
        )}
        {permissions.map((permission) => (
          <PermissionCard key={permission.requestId} permission={permission} sessionId={session.id} onDone={onPermissionDone} onError={onPermissionError} />
        ))}
        {liveActivity && <LiveActivity activity={liveActivity} />}
      </div>
      {searchOpen && (
        <ConversationSearch
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            setActiveMatch(0);
          }}
          current={currentMatch}
          total={matches.length}
          onNext={() => {
            if (matches.length > 0) setActiveMatch((currentMatch + 1) % matches.length);
          }}
          onPrev={() => {
            if (matches.length > 0) setActiveMatch((currentMatch - 1 + matches.length) % matches.length);
          }}
          onClose={() => {
            scrollKeyRef.current = "";
            setSearchOpen(false);
          }}
          focusSignal={focusSignal}
          {...(hasMoreMessages ? { loadedOnly: true } : {})}
        />
      )}
      {!pinned && (
        <button
          className="scroll-bottom"
          aria-label={t("回到底部", "Jump to bottom")}
          onClick={() => {
            scrollToBottom(true);
            setPinned(true);
          }}
        >
          <Icon name="arrow-down" size={13} /> <span className="scroll-bottom-label">{t("回到底部", "Jump to bottom")}</span>
        </button>
      )}
    </div>
  );
}
