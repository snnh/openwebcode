/**
 * 会话区容器：装配 SessionHeader + MessageList + 交互卡/Steering 队列 + Composer + todos。
 * 发送/编辑重发/重新生成/分叉/中断/配置变更等会话动作全部在此（旧 App.tsx 对应逻辑的移植）；
 * 共享动作经 ChatActionsContext 下发（chat/types.ts 契约）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { extractAttachmentPaths, toAttachments } from "../lib/attachments";
import type { AgentRun, ChatMessage, SessionDetail } from "../lib/contracts";
import { formatCurrency } from "../lib/format";
import { deriveWindowInfo } from "../lib/context-window";
import { INACTIVE_STATES, isBusyState } from "../lib/agent-state";
import { useStore } from "../app/store";
import { qk, useContextViewQuery, useInteractionsQuery, useModelsQuery, usePendingPermissionsQuery, useQueueQuery, useSessionQuery, useTodosQuery, useExtensionsQuery } from "../app/queries";
import { sessionMeta, sessionStore } from "../app/session-store";
import { deriveActivityInfo, live, useLiveActivityEntry, useLiveCompactions, useLiveSubagentRuns, type LiveActivityInfo } from "../app/live-store";
import { deriveRestoredCompactions, mergeCompactionMarkers } from "../lib/compaction";
import { auxViews } from "../workbench/aux-views";
import { ui } from "../app/ui-store";
import { chatBridge } from "../app/chat-bridge";
import { deriveSubagentRunsFromMessages, mergeSubagentRuns } from "../lib/subagent-runs";
import type { UseSubagentTabsResult } from "../hooks/use-subagent-tabs";
import type { UseTerminalTabsResult } from "../hooks/use-terminal-tabs";
import { useStreamBlocks } from "./stream-buffer";
import { useOlderMessages, loadOlderMessages } from "./pagination-store";
import { clearComposerState, getAttachments, getDraft, setDraftValue } from "../composer/drafts";
import { ChatActionsContext, type ChatActions, type EditingMessage } from "./types";
import { MessageList } from "./MessageList";
import { SubagentTabStrip, SubagentTabView } from "./SubagentTabs";
import { TerminalView } from "../terminal/TerminalView";
import { InteractionCard } from "./cards/InteractionCard";
import { PlanApprovalCard } from "./cards/PlanApprovalCard";
import { SteeringQueue } from "./cards/SteeringQueue";
import { Composer } from "../composer/Composer";
import { SessionHeader } from "../workbench/SessionHeader";
import { SessionSkeleton } from "../components/SessionSkeleton";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

export interface ChatViewProps {
  sessionId: string;
  /** useAgentRun 的 REST/WS 合并 run 快照（App 装配层实例化） */
  currentRun?: AgentRun | undefined;
  /** 主区子代理/终端标签状态（App 装配层实例化，按会话隔离） */
  subagentTabs: UseSubagentTabsResult;
  terminalTabs: UseTerminalTabsResult;
  /** 移动端：打开左上角导航菜单 */
  onOpenNavMenu?(): void;
}

export function ChatView({ sessionId, currentRun, subagentTabs, terminalTabs, onOpenNavMenu }: ChatViewProps): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const detail = useSessionQuery(sessionId);
  const models = useModelsQuery();
  const contextView = useContextViewQuery(sessionId);
  const queue = useQueueQuery(sessionId);
  const interactions = useInteractionsQuery(sessionId);
  const todos = useTodosQuery(sessionId);
  const serverPermissions = usePendingPermissionsQuery(sessionId);
  const extensions = useExtensionsQuery();
  const contentLens = useMemo(() => extensions.data?.find((extension) => extension.id === "content-lens" && extension.enabled), [extensions.data]);

  const current = detail.data;
  const agentState = useStore(sessionStore, (state) => state.agentStates[sessionId]);
  const watermark = useStore(sessionStore, (state) => state.watermarks[sessionId]);
  const latestUsage = useStore(sessionStore, (state) => state.usages[sessionId]);
  const runError = useStore(sessionStore, (state) => state.runFailures[sessionId]);
  const localPermissions = useStore(sessionStore, (state) => state.pendingPermissions);
  const streamBlocks = useStreamBlocks(sessionId);
  const liveSubagents = useLiveSubagentRuns(sessionId);
  const activityEntry = useLiveActivityEntry(sessionId);
  const liveCompactions = useLiveCompactions(sessionId);
  // 压缩检查点标记：实时事件（运行中/沉降/失败）+ 账本还原（多次历史，带摘要可展开）合并
  const compactionMarkers = useMemo(
    () => mergeCompactionMarkers(liveCompactions, deriveRestoredCompactions(contextView.data)),
    [liveCompactions, contextView.data],
  );

  const currentState = currentRun?.state ?? agentState;
  const running = streamBlocks.length > 0 || isBusyState(currentState);

  // 合并分页加载的更早消息，形成完整显示会话
  const older = useOlderMessages(sessionId);
  const displaySession = useMemo<SessionDetail | undefined>(() => {
    if (!current) return current;
    if (older.older.length === 0) return current;
    return { ...current, messages: [...older.older, ...current.messages] };
  }, [current, older.older]);
  // 未翻页前以详情尾页的是否还有更早消息为准；翻过页后以分页缓存为准
  const hasMoreMessages = older.older.length > 0 ? older.hasMore : current?.hasMoreMessages === true || older.hasMore;
  const onLoadMore = useCallback((): void => {
    if (!current || older.loading) return;
    const oldestId = older.older[0]?.id ?? current.messages[0]?.id;
    if (!oldestId) return;
    void loadOlderMessages(sessionId, oldestId);
  }, [current, older, sessionId]);

  // 子代理标签数据源：实时运行优先，消息推导的历史运行补齐（刷新后无实时事件时标签状态仍可用）
  const derivedSubagentRuns = useMemo(() => deriveSubagentRunsFromMessages(displaySession?.messages ?? []), [displaySession]);
  const subagentRuns = useMemo(() => mergeSubagentRuns(liveSubagents, derivedSubagentRuns), [liveSubagents, derivedSubagentRuns]);
  // 主区标签（按会话隔离）：selectedSubagentTab 缺省表示「主对话」（或终端选中时的终端）
  const currentSubagentTabs = subagentTabs.tabsBySession[sessionId] ?? [];
  const selectedSubagentTab = subagentTabs.selectedBySession[sessionId];
  const terminalOpen = terminalTabs.openBySession[sessionId] === true;
  const terminalSelected = terminalOpen && terminalTabs.selectedBySession[sessionId] === true;
  // 选中互斥：选主对话/子代理标签时取消终端选中，反之亦然
  const onSelectTab = useCallback((toolCallId?: string): void => {
    subagentTabs.selectTab(sessionId, toolCallId);
    terminalTabs.setTerminalSelected(sessionId, false);
  }, [sessionId, subagentTabs, terminalTabs]);
  const onSelectTerminal = useCallback((): void => {
    subagentTabs.selectTab(sessionId, undefined);
    terminalTabs.setTerminalSelected(sessionId, true);
  }, [sessionId, subagentTabs, terminalTabs]);
  const chatVisible = selectedSubagentTab === undefined && !terminalSelected;

  // 服务端待决列表 + WS 即时权限卡，按 requestId 去重合并
  const mergedPermissions = useMemo(() => {
    const server = serverPermissions.data ?? [];
    const local = localPermissions.filter((item) => !server.some((entry) => entry.requestId === item.requestId));
    return [...server, ...local];
  }, [serverPermissions.data, localPermissions]);

  // 对话区底部实时活动条：WS 工具事件优先，状态/起始时间回退到 run 快照（刷新页面后首个事件前可用）
  const liveActivity = useMemo<LiveActivityInfo | undefined>(() => {
    const info = deriveActivityInfo(activityEntry);
    const state = info?.state ?? currentState;
    if (!state || INACTIVE_STATES.has(state)) return undefined;
    const since = info?.since ?? (currentRun?.since ? Date.parse(currentRun.since) : undefined);
    return {
      state,
      ...(since !== undefined && !Number.isNaN(since) ? { since } : {}),
      ...(info?.currentTool ? { currentTool: info.currentTool } : {}),
      toolCount: info?.toolCount ?? 0,
    };
  }, [activityEntry, currentState, currentRun?.since]);

  const model = useMemo(() => models.data?.find((item) => item.id === current?.model && item.provider === current?.provider), [models.data, current?.model, current?.provider]);
  // 上下文窗口占用：WS 实时水位优先，否则由 REST stats + 模型档案播种（刷新后首个 watermark 前可用）
  const windowInfo = useMemo(() => deriveWindowInfo(watermark, contextView.data?.stats, model), [watermark, contextView.data?.stats, model]);

  const costSummary = useMemo(() => {
    const ledger = contextView.data?.ledger;
    if (!ledger || !contextView.data) return undefined;
    const currency = contextView.data.preferences.currency;
    return {
      tokens: ledger.usage.inputTokens + ledger.usage.outputTokens,
      costLabel: formatCurrency(currency === "CNY" ? ledger.cost.cnyMicroUnits : ledger.cost.usdMicroUnits, currency),
      tokenBudget: ledger.policy?.maxSessionTokens,
      paused: currentState === "budget_paused",
      unpricedTokens: ledger.cost.unpricedTokens,
    };
  }, [contextView.data, currentState]);

  const notify = ui.notify;

  // ===== 编辑重发：进入时暂存当前草稿并把目标 user 消息文本灌入 Composer；取消/Esc/切换会话恢复暂存 =====
  const [editingMessage, setEditingMessage] = useState<{ sessionId: string; messageId: string; hadAttachments: boolean } | undefined>();
  const editingRef = useRef(editingMessage);
  useEffect(() => { editingRef.current = editingMessage; }, [editingMessage]);
  const editStashRef = useRef("");
  const focusComposer = useCallback((): void => {
    document.getElementById("composer-input")?.focus();
  }, []);
  const cancelEdit = useCallback((restoreDraft = true): void => {
    const target = editingRef.current;
    if (!target) return;
    if (restoreDraft) setDraftValue(target.sessionId, editStashRef.current);
    setEditingMessage(undefined);
  }, []);
  const startEditMessage = useCallback((message: ChatMessage): void => {
    if (running) return;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (!text) return;
    editStashRef.current = getDraft(sessionId);
    setEditingMessage({ sessionId, messageId: message.id, hadAttachments: message.content.some((block) => block.type !== "text") });
    setDraftValue(sessionId, text);
    focusComposer();
  }, [sessionId, running, focusComposer]);
  // 会话切换：退出编辑态并把暂存草稿还给原会话；本地即时权限卡改由服务端列表播种
  useEffect(() => {
    const target = editingRef.current;
    if (target && target.sessionId !== sessionId) cancelEdit();
    sessionMeta.clearPermissions();
  }, [sessionId, cancelEdit]);

  const send = useMutation({
    mutationFn: async (input: { sessionId: string; text: string; behavior: "start" | "steer" | "follow_up" }) => {
      const images = getAttachments(input.sessionId).map(({ mediaType, data }) => ({ mediaType, data }));
      const pathAttachments = toAttachments(extractAttachmentPaths(input.text));
      // `!` 前缀走 shell 快捷路由：不进 agent run，权限挂起时后端 409 由 onError 提示
      if (input.text.startsWith("!")) return api.runShell(input.sessionId, input.text.slice(1).trim());
      return api.sendMessage(input.sessionId, input.text, images, pathAttachments.length ? pathAttachments : undefined, input.behavior);
    },
    onSuccess: (result, input) => {
      clearComposerState(input.sessionId);
      const queued = result as { queued?: boolean; position?: number } | undefined;
      if (queued?.queued) notify(input.behavior === "follow_up"
        ? t(`已加入完成后续跑队列（第 ${queued.position} 项）`, `Added to follow-up queue (position ${queued.position})`)
        : t(`已加入 Steering 队列（第 ${queued.position} 项）`, `Added to Steering queue (position ${queued.position})`));
      // /compact 沉降兜底：changed 时运行中占位已由 context.compacted 事件原位沉降；
      // 空跑（compacted:false）或无声失败时清掉占位，消息流不留残痕
      if (/^\/compact(?:\s|$)/i.test(input.text.trim())) {
        live.clearRunningCompaction(input.sessionId);
        if ((result as { compacted?: boolean }).compacted === false) {
          notify((result as { result?: { reason?: string } }).result?.reason ?? t("无需压缩", "No compaction needed"));
        }
      }
      void queryClient.invalidateQueries({ queryKey: qk.session(input.sessionId) });
    },
    onError: (error, input) => {
      if (/^\/compact(?:\s|$)/i.test(input.text.trim())) live.clearRunningCompaction(input.sessionId);
      notify(error instanceof Error ? error.message : t("发送失败", "Send failed"), "error");
    },
  });

  // Composer 发送与编辑重发共用的提交逻辑
  const submitDraft = useCallback((behavior?: "start" | "steer" | "follow_up"): void => {
    // 请求进行中（如 /compact 同步压缩可能耗时）防重复提交：避免二次压缩或 run 与压缩抢写账本
    if (send.isPending) return;
    const text = getDraft(sessionId).trim();
    if (!text) return;
    // 编辑重发：走 retry（检出到父节点 + 附带编辑后的 user 消息重跑），不走普通消息 POST
    if (editingMessage && editingMessage.sessionId === sessionId) {
      const target = editingMessage;
      cancelEdit(false);
      api.retryMessage(sessionId, target.messageId, { editedContent: text })
        .then(() => {
          clearComposerState(sessionId);
          void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
          void queryClient.invalidateQueries({ queryKey: qk.timeline(sessionId) });
        })
        .catch((error: unknown) => notify(error instanceof Error ? error.message : t("重发失败", "Resend failed"), "error"));
      return;
    }
    // /help 是纯客户端内置命令：打开设置「快捷键」页签，不进 agent run
    if (text === "/help") {
      setDraftValue(sessionId, "");
      ui.openSettings("shortcuts");
      return;
    }
    send.mutate({ sessionId, text, behavior: behavior ?? (running ? "steer" : "start") });
  }, [sessionId, editingMessage, cancelEdit, queryClient, notify, t, send, running]);

  // 命令体系（Ctrl+Enter/命令面板「发送消息」）经桥路由到 submitDraft
  useEffect(() => {
    chatBridge.submitDraft = submitDraft;
    return () => { chatBridge.submitDraft = undefined; };
  }, [submitDraft]);

  // 错误卡「重试」：重发本会话最近一条用户消息（跳过 `!` 前缀的 shell 快捷消息）
  const lastUserMessageText = useMemo(() => {
    const messages = displaySession?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role !== "user") continue;
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
        .trim();
      if (text && !text.startsWith("!")) return text;
    }
    return undefined;
  }, [displaySession]);
  const retryRun = useCallback((): void => {
    if (!lastUserMessageText || running) return;
    send.mutate({ sessionId, text: lastUserMessageText, behavior: "start" });
  }, [sessionId, lastUserMessageText, running, send]);

  // 重新生成：检出到该 user 消息的父节点并重跑（服务端 202 起新 run）
  const regenerateMessage = useCallback((message: ChatMessage): void => {
    if (running) return;
    api.retryMessage(sessionId, message.id, {})
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
        void queryClient.invalidateQueries({ queryKey: qk.timeline(sessionId) });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("重新生成失败", "Regeneration failed"), "error"));
  }, [sessionId, running, queryClient, notify, t]);

  // 分叉：复制到该节点为止的对话为新会话并切换过去（运行中允许）
  const forkMessage = useCallback((message: ChatMessage): void => {
    api.forkSession(sessionId, { messageId: message.id })
      .then(({ sessionId: newId }) => {
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        ui.selectSession(newId);
        notify(t("已分叉到新会话", "Forked into a new session"));
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("分叉失败", "Fork failed"), "error"));
  }, [sessionId, queryClient, notify, t]);

  // 托管工作区的镜像盘快照必须由用户显式触发；服务端仍会拒绝运行中或同步中的会话。
  const manualSnapshot = useMutation({
    mutationFn: (id: string) => api.createCheckpoint(id, t("手动虚拟磁盘快照", "Manual virtual disk snapshot")),
    onSuccess: (checkpoint, id) => {
      notify(t(`已创建虚拟磁盘快照「${checkpoint.label}」`, `Virtual disk snapshot “${checkpoint.label}” created`));
      void queryClient.invalidateQueries({ queryKey: qk.checkpoints(id) });
      void queryClient.invalidateQueries({ queryKey: qk.session(id) });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("未知错误", "unknown error");
      notify(t(`创建虚拟磁盘快照失败：${message}`, `Could not create virtual disk snapshot: ${message}`), "error");
    },
  });

  // shell 结果卡「发给 agent」：把 `!cmd` 与输出摘要作为普通用户消息送入 agent run
  const sendShellToAgent = useCallback((cmd: string, output: string): void => {
    const summary = output.length > 2000 ? t(`${output.slice(0, 2000)}\n…（输出已截断）`, `${output.slice(0, 2000)}\n…(output truncated)`) : output;
    api.sendMessage(sessionId, t(`刚才执行的 shell 命令：\n${cmd}\n\n输出：\n${summary}`, `Shell command just executed:\n${cmd}\n\nOutput:\n${summary}`))
      .then(() => queryClient.invalidateQueries({ queryKey: qk.session(sessionId) }))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("发送失败", "Send failed"), "error"));
  }, [sessionId, queryClient, notify, t]);

  const onAbort = useCallback((): void => {
    api.abort(sessionId).catch((error: unknown) => notify(error instanceof Error ? error.message : t("无法中断", "Could not stop the job"), "error"));
  }, [sessionId, notify, t]);

  // 会话配置（模式/沙盒/Shell 等）：直写缓存合并 + 失效重取（返回 Promise 供调用方 pending 态）
  const onConfig = useCallback((body: Record<string, unknown>): Promise<void> => api.updateSession(sessionId, body)
    .then((updated) => {
      queryClient.setQueryData<SessionDetail>(qk.session(sessionId), (previous) => previous ? { ...previous, ...updated } : previous);
      void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
    })
    .catch((error: unknown) => {
      notify(error instanceof Error ? error.message : t("模式切换失败", "Mode change failed"), "error");
    }), [sessionId, queryClient, notify, t]);

  const chatActions = useMemo<ChatActions>(() => ({
    sessionId,
    running,
    ...(contentLens ? { contentLens } : {}),
    onNotice: (text, kind = "info") => notify(text, kind),
    // 统一 diff 视图（编辑器分栏互斥，由 aux-views 管理）
    onOpenDiff: (spec) => auxViews.openDiff(spec),
    // 产出文件行/工具卡文件路径 → 编辑器分栏打开
    onOpenFile: (path) => auxViews.openEditor(path),
    onSendToAgent: sendShellToAgent,
    onEditMessage: startEditMessage,
    onRegenerate: regenerateMessage,
    onFork: forkMessage,
  }), [sessionId, running, contentLens, notify, sendShellToAgent, startEditMessage, regenerateMessage, forkMessage]);

  if (!current) {
    // 会话详情首次加载中：渲染对话骨架，避免欢迎页闪烁
    return detail.isPending ? <SessionSkeleton /> : <section className="workbench" />;
  }

  const editingForComposer: EditingMessage | undefined = editingMessage && editingMessage.sessionId === current.id
    ? { messageId: editingMessage.messageId, hadAttachments: editingMessage.hadAttachments }
    : undefined;

  return (
    <section className="workbench">
      <SessionHeader
        session={current}
        {...(currentState ? { agentState: currentState } : {})}
        {...(costSummary ? { costSummary } : {})}
        {...(windowInfo ? { windowUsage: windowInfo } : {})}
        {...(latestUsage ? { latestUsage } : {})}
        running={running}
        checkpointPending={manualSnapshot.isPending}
        onAbort={onAbort}
        onConfig={onConfig}
        onCreateCheckpoint={() => manualSnapshot.mutate(current.id)}
        {...(onOpenNavMenu ? { onOpenNavMenu } : {})}
      />
      <SubagentTabStrip
        tabs={currentSubagentTabs}
        runs={subagentRuns}
        selected={selectedSubagentTab}
        {...(terminalOpen ? { terminal: { selected: terminalSelected } } : {})}
        onSelect={onSelectTab}
        onClose={(toolCallId) => subagentTabs.closeTab(sessionId, toolCallId)}
        onSelectTerminal={onSelectTerminal}
        onCloseTerminal={() => terminalTabs.closeTerminal(sessionId)}
      />
      {todos.data && todos.data.length > 0 && (
        <details className="todo-panel" open>
          <summary>{t("任务清单", "Task list")} · {todos.data.filter((item) => item.status === "done").length}/{todos.data.length}</summary>
          <ul>{todos.data.map((item, index) => (
            <li key={`${item.content}-${index}`} data-status={item.status}>
              <span>{item.status === "done" ? <Icon name="check" size={12} /> : item.status === "in_progress" ? <Icon name="circle-filled" size={10} /> : <Icon name="circle" size={12} />}</span>
              {item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}
            </li>
          ))}</ul>
        </details>
      )}
      <ChatActionsContext.Provider value={chatActions}>
        {/* 主对话/终端/子代理标签内容互换：MessageList 与终端保持挂载（hidden 隐藏），滚动与 PTY 状态不丢 */}
        <div className="main-tab-panel" role="tabpanel" aria-label={t("主对话", "Main")} hidden={!chatVisible}>
          <MessageList
            session={displaySession ?? current}
            {...(contextView.data?.ledger.cleared ? { cleared: contextView.data.ledger.cleared } : {})}
            compactions={compactionMarkers}
            hasMoreMessages={hasMoreMessages}
            loadingMore={older.loading}
            onLoadMore={onLoadMore}
            streamBlocks={streamBlocks}
            {...(runError ? { runError } : {})}
            permissions={mergedPermissions}
            {...(liveActivity ? { liveActivity } : {})}
            liveSubagents={liveSubagents}
            running={running}
            visible={chatVisible}
            {...(lastUserMessageText && !running ? { onRetryRun: retryRun } : {})}
            retryPending={send.isPending}
            onPermissionDone={(requestId) => {
              sessionMeta.removePermission(requestId);
              void queryClient.invalidateQueries({ queryKey: qk.permissions(current.id) });
            }}
          />
        </div>
      </ChatActionsContext.Provider>
      {terminalOpen && (
        <div className="main-tab-panel" role="tabpanel" aria-label={t("终端", "Terminal")} hidden={!terminalSelected}>
          <TerminalView sessionId={current.id} />
        </div>
      )}
      {selectedSubagentTab !== undefined && (
        <div className="main-tab-panel" role="tabpanel" aria-label={t("子代理", "Subagent")}>
          <SubagentTabView sessionId={current.id} toolCallId={selectedSubagentTab} runs={subagentRuns} />
        </div>
      )}
      {queue.data?.some((item) => item.status === "queued") && (
        <SteeringQueue
          items={queue.data}
          onRemove={(itemId) => api.removeQueue(current.id, itemId)
            .then(() => queue.refetch())
            .catch((error: unknown) => notify(error instanceof Error ? error.message : t("撤销 Steering 失败", "Could not remove Steering item"), "error"))}
        />
      )}
      {interactions.data?.filter((item) => item.status === "pending").map((item) => (
        item.kind === "plan_approval"
          ? <PlanApprovalCard key={item.id} item={item} onRespond={(answer) => api.respondInteraction(current.id, item.id, answer)
            // 批准后 server 侧已切 build：除事件驱动的 detail 刷新外，本地立即失效会话配置查询
            .then(() => { void interactions.refetch(); void queryClient.invalidateQueries({ queryKey: qk.session(current.id) }); })
            .catch((error: unknown) => notify(error instanceof Error ? error.message : t("提交回答失败", "Could not submit answer"), "error"))} />
          : <InteractionCard key={item.id} item={item} onRespond={(answer) => api.respondInteraction(current.id, item.id, answer)
            .then(() => interactions.refetch())
            .catch((error: unknown) => notify(error instanceof Error ? error.message : t("提交回答失败", "Could not submit answer"), "error"))} />
      ))}
      <Composer
        session={current}
        running={running}
        onSend={(behavior) => submitDraft(behavior)}
        onConfig={onConfig}
        {...(editingForComposer ? { editingMessage: editingForComposer } : {})}
        onCancelEdit={() => cancelEdit()}
      />
    </section>
  );
}
