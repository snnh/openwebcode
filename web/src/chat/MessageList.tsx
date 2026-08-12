import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ChatMessage, LiveSubagentRun } from "../lib/contracts";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { MemoMessageCard } from "./MessageCard";
import { shellCommandOf } from "../lib/shell-messages";
import { ProcessFold } from "./ProcessFold";
import { LiveStream } from "./LiveStream";
import { RunErrorCard } from "./cards/RunErrorCard";
import { PermissionCard } from "./cards/PermissionCard";
import { LiveActivityBar } from "./cards/LiveActivityBar";
import { ConversationSearchBar, findMatches, highlightArticle, unwrapSearchMarks } from "./search";
import { CONVERSATION_SEARCH_EVENT, type MessageListProps } from "./types";
import { createScrollFollower, type ScrollFollower } from "./scroll-controller";
import { buildRenderItems, insertCompactionMarkers, turnOf } from "./message-groups";
import { CompactionRow } from "./cards/CompactionRow";

/** 全会话工具结果配对表：toolCallId → isError（工具调用行的状态图标数据源） */
function buildToolResultStatus(messages: ChatMessage[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolCallId) map[block.toolCallId] = Boolean(block.isError);
    }
  }
  return map;
}

/** 提取消息内 spawn_task/spawn_swarm 工具调用关联的实时子代理运行（无则 undefined，保持 memo 稳定） */
function liveRunsForMessage(message: ChatMessage, liveSubagents: Record<string, LiveSubagentRun>): LiveSubagentRun[] | undefined {
  const callIds = new Set(
    message.content
      .filter((block) => block.type === "tool_call" && (block.name === "spawn_task" || block.name === "spawn_swarm"))
      .map((block) => block.id),
  );
  if (callIds.size === 0) return undefined;
  const runs = Object.values(liveSubagents).filter((run) => callIds.has(run.toolCallId));
  return runs.length > 0 ? runs : undefined;
}

/**
 * 聊天滚动区：消息列表 + 流式区 + 权限卡 + 活动条 + 搜索 + 分页哨兵 + 回到底部。
 *
 * 与旧 ExecutionTrack 的关键差异（三个滚动 bug 的根治）：
 * ① 废弃 JS 虚拟化（spacer/估算高/测量），改纯流式布局 + CSS content-visibility；
 *    吸底改由 scroll-controller 掌管——只有 following 时内容变化才吸底，上滚阅读绝不拽回。
 * ② 前插历史用 preparePrepend/applyPrepend 按 scrollHeight 差值锚定，视口不跳。
 * ③ 会话内搜索不再包/拆 <mark> 之外没有其他 DOM 写——高亮仍由布局效果统一施加，
 *    但跳转仅在「查询/当前命中变化」时（scrollKey 去重），用户手动滚动不拽回。
 */
export function MessageList({
  session,
  cleared,
  compactions,
  hasMoreMessages,
  loadingMore,
  onLoadMore,
  streamBlocks,
  runError,
  permissions,
  liveActivity,
  liveSubagents,
  running,
  visible = true,
  onRetryRun,
  retryPending,
  onPermissionDone,
}: MessageListProps): ReactElement {
  const { t, locale } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<ScrollFollower | null>(null);
  if (followerRef.current === null) followerRef.current = createScrollFollower();
  const [following, setFollowing] = useState(true);

  const messages = session.messages;

  // ===== 滚动跟随接线：attach/detach 一次，following 变化经订阅进 React 状态（仅布尔翻转，非每帧） =====
  useEffect(() => {
    const follower = followerRef.current!;
    const el = trackRef.current;
    if (!el) return undefined;
    follower.attach(el);
    const unsubscribe = follower.onFollowingChange(setFollowing);
    return () => {
      unsubscribe();
      follower.detach();
    };
  }, []);

  // 内容变化 → 通知控制器（仅 following 时吸底；effect 内直接调，不做任何 setState）
  // visible=false（标签互斥隐藏）时暂停；恢复可见时本 effect 重跑，following 则重新贴底
  useEffect(() => {
    if (!visible) return;
    followerRef.current!.notifyContentChanged();
  }, [visible, messages.length, streamBlocks, permissions.length]);

  // ===== 会话切换：restore 滚动位置或贴底；卸载/再切换前 remember =====
  useLayoutEffect(() => {
    const el = trackRef.current;
    const follower = followerRef.current!;
    if (el) {
      const target = follower.restore(session.id);
      el.scrollTop = target === "bottom" ? el.scrollHeight : target;
    }
    return () => follower.remember(session.id);
  }, [session.id]);

  // ===== 分页：顶部哨兵 + 前插锚定 =====
  const firstMessageId = messages[0]?.id;
  const prevFirstMessageIdRef = useRef(firstMessageId);
  const prependPendingRef = useRef(false);

  const handleLoadMore = useCallback((): void => {
    if (loadingMore || !hasMoreMessages) return;
    followerRef.current!.preparePrepend();
    prependPendingRef.current = true;
    onLoadMore();
  }, [loadingMore, hasMoreMessages, onLoadMore]);

  // 前插完成后（首项 id 变化）按高度差补偿滚动，视口不跳
  useLayoutEffect(() => {
    if (prevFirstMessageIdRef.current === firstMessageId) return;
    prevFirstMessageIdRef.current = firstMessageId;
    if (prependPendingRef.current) {
      prependPendingRef.current = false;
      followerRef.current!.applyPrepend();
    }
  }, [firstMessageId]);

  // 加载结束但未发生前插（失败/空页）：收尾恢复 overflow-anchor（scrollTop 数值上不变）
  useLayoutEffect(() => {
    if (loadingMore || !prependPendingRef.current) return;
    prependPendingRef.current = false;
    followerRef.current!.applyPrepend();
  }, [loadingMore]);

  // 哨兵入视即加载更早消息（无 IntersectionObserver 的环境由下方按钮兜底）
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handleLoadMore();
      },
      { root: trackRef.current, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  // ===== 分组与配对表 =====
  const turns = useMemo(() => turnOf(messages), [messages]);
  // clear 分隔线定位：ledger 记的 uptoIndex 是全量历史绝对下标，session.messages 是分页尾部窗口，
  // 需减去页偏移换算成窗口内下标；clear 点在未加载的早期历史里（< 0）时不渲染，加载更早消息后自然就位
  const pageOffset = Math.max(0, (session.messageCount ?? messages.length) - messages.length);
  const clearedLocal = cleared ? cleared.uptoIndex - pageOffset : undefined;
  const items = useMemo(
    () => {
      const base = buildRenderItems(messages, { foldProcess: !running, ...(clearedLocal !== undefined ? { clearedLocal } : {}) });
      if (!compactions || compactions.length === 0) return base;
      // 检查点定位与 clear 分隔线同口径：账本 uptoIndex 是全量历史绝对下标，减去页偏移换算窗口内下标；
      // 运行中占位（uptoIndex<0）与超出已加载窗口的标记钳制到边界（最早加载消息之前 / 尾部）
      const marks = compactions.map((marker) => ({
        position: marker.uptoIndex < 0 ? messages.length : Math.min(Math.max(marker.uptoIndex - pageOffset, 0), messages.length),
        marker,
      }));
      return insertCompactionMarkers(base, marks, messages.length);
    },
    [messages, running, clearedLocal, compactions, pageOffset],
  );
  const toolResults = useMemo(() => buildToolResultStatus(messages), [messages]);

  // ===== 会话内搜索（Ctrl+F）：状态留在本层 =====
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

  const matches = useMemo(() => findMatches(messages, query), [messages, query]);
  const currentMatch = matches.length === 0 ? 0 : Math.min(activeMatch, matches.length - 1);

  // 高亮：不动 React 渲染，layout effect 内对 article 文本节点包/拆 <mark>（content-visibility 下 DOM 常驻可达）。
  // MutationObserver 兜底 Markdown 懒加载换壳；自身包/拆 mark 的变动被过滤，不会自激。
  // scrollIntoView 仅在「查询或当前命中变化」时执行（scrollKeyRef 去重），用户手动滚动不被拽回。
  const scrollKeyRef = useRef("");
  useLayoutEffect(() => {
    const root = trackRef.current;
    if (!root) return undefined;
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
    if (!searchOpen || !query || matches.length === 0) return undefined;
    const active = matches[currentMatch];
    if (active) {
      const scrollKey = `${query}#${currentMatch}`;
      if (scrollKeyRef.current !== scrollKey) {
        scrollKeyRef.current = scrollKey;
        const target = root.querySelector(`article[data-message-id="${active.messageId}"]`);
        // jsdom 无 scrollIntoView，测试环境跳过
        if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
      }
    }
    const observer = new MutationObserver((records) => {
      const foreign = records.some((record) =>
        Array.from(record.addedNodes).some((node) => node instanceof HTMLElement && !node.matches("mark.conv-search-hit")));
      if (foreign) applyHighlights();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [searchOpen, query, matches, currentMatch]);

  // ===== 渲染 =====
  // clear 分隔线与压缩检查点行同视觉族：图标 + 文案，清空时间经 title 悬浮可见
  const divider = (
    <div
      className="context-cleared-divider"
      role="separator"
      {...(cleared ? { title: new Date(cleared.at).toLocaleString(locale) } : {})}
    >
      <Icon name="compress" size={11} />
      {t("上下文已清空（历史保留）", "Context cleared (history retained)")}
    </div>
  );

  const renderMessage = (index: number, showDivider: boolean): ReactNode => {
    const message = messages[index]!;
    const liveRuns = liveRunsForMessage(message, liveSubagents);
    // shell 快捷命令的结果卡（user `!cmd` + tool_result 配对）附「发给 agent」按钮：命令文本取自前一条 user 消息
    const shellCmd = message.role === "tool" ? shellCommandOf(messages[index - 1]) : undefined;
    return (
      <Fragment key={message.id}>
        {showDivider && clearedLocal === index && divider}
        <MemoMessageCard
          message={message}
          turn={turns[index] ?? 0}
          toolResults={toolResults}
          {...(liveRuns ? { liveSubagents: liveRuns } : {})}
          {...(shellCmd !== undefined ? { shellCmd } : {})}
        />
      </Fragment>
    );
  };

  return (
    <div className="chat-track-wrap">
      <div className="chat-track" ref={trackRef}>
        {hasMoreMessages && <div className="chat-top-sentinel" ref={sentinelRef} aria-hidden />}
        {loadingMore && <div className="chat-loading-row">{t("加载中…", "Loading…")}</div>}
        {hasMoreMessages && !loadingMore && typeof IntersectionObserver === "undefined" && (
          <div className="load-more-bar">
            <button className="load-more-btn" onClick={handleLoadMore}>
              {t("加载更早的消息", "Load earlier messages")}
            </button>
          </div>
        )}
        {messages.length === 0 && streamBlocks.length === 0 && (
          <p className="muted-empty track-empty">{t("还没有消息。在下方描述要完成的任务，开始第一项作业。", "No messages yet. Describe a task below to start your first job.")}</p>
        )}
        {items.map((item) => {
          if (item.kind === "message") return renderMessage(item.index, item.showDivider);
          if (item.kind === "compaction") return <CompactionRow key={item.marker.id} marker={item.marker} />;
          // 连续过程消息段 → 单个默认折叠组；clear 分隔线落在段首时外置到折叠组之前，避免折进折叠区不可见
          const startId = messages[item.start]!.id;
          const children: ReactNode[] = [];
          for (let index = item.start; index < item.end; index += 1) {
            children.push(renderMessage(index, clearedLocal !== index));
          }
          return (
            <Fragment key={`fold-${startId}`}>
              {clearedLocal === item.start && divider}
              <ProcessFold toolCalls={item.toolCalls} failed={item.failed}>
                {children}
              </ProcessFold>
            </Fragment>
          );
        })}
        {clearedLocal === messages.length && messages.length > 0 && divider}
        {runError && (
          <RunErrorCard
            error={runError}
            {...(onRetryRun ? { onRetryRun } : {})}
            {...(retryPending !== undefined ? { retryPending } : {})}
          />
        )}
        {streamBlocks.length > 0 && <LiveStream blocks={streamBlocks} turn={turns.at(-1) ?? 0} />}
        {permissions.map((permission) => (
          <PermissionCard key={permission.requestId} permission={permission} onDone={onPermissionDone} />
        ))}
        {liveActivity && <LiveActivityBar activity={liveActivity} />}
      </div>
      {searchOpen && (
        <ConversationSearchBar
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
      {!following && (
        <button
          className="scroll-bottom"
          aria-label={t("回到底部", "Jump to bottom")}
          onClick={() => followerRef.current!.scrollToBottom(true)}
        >
          <Icon name="arrow-down" size={13} /> <span className="scroll-bottom-label">{t("回到底部", "Jump to bottom")}</span>
        </button>
      )}
    </div>
  );
}
