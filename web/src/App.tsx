import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { extractAttachmentPaths, toAttachments } from "./lib/attachments";
import type { AppEvent, BackgroundTaskInfo, SessionDetail, TodoItem } from "./lib/contracts";
import { formatCurrency } from "./lib/format";
import { loadSendKey, loadSessionDefaults, saveSendKey, saveSessionDefaults, type SendKey, type SessionDefaults } from "./lib/prefs";
import { useTheme } from "./theme";
import { useAgentRun } from "./hooks/use-agent-run";
import { useSessionEventStream } from "./hooks/use-session-event-stream";
import { BottomPanel } from "./components/BottomPanel";
import { StatusBar } from "./components/StatusBar";
import { InteractionCard } from "./components/InteractionCard";
import { Composer } from "./components/Composer";
import type { PendingImage } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { ExecutionTrack } from "./components/ExecutionTrack";
import { isBusyState, JobHeader } from "./components/JobHeader";
import { NewSessionDialog, type NewSessionValues } from "./components/NewSessionDialog";
import type { PermissionRequest } from "./components/PermissionCard";
import { clampRailWidth, SessionRail } from "./components/SessionRail";
import { SettingsDialog } from "./components/SettingsDialog";
import { SteeringQueue } from "./components/SteeringQueue";
import { Toast, type Notice } from "./components/Toast";
import { useI18n } from "./i18n";

const queryKeys = { sessions: ["sessions"] as const, detail: (id: string) => ["session", id] as const, skills: (id: string) => ["skills", id] as const };

function readStoredSetting(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响使用
  }
}

export function App(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { theme, preference, setPreference, toggleTheme, accent, setAccent } = useTheme();
  const [currentId, setCurrentId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(() => clampRailWidth(Number(readStoredSetting("owc-rail-width")) || 250));
  const [railCollapsed, setRailCollapsed] = useState(() => readStoredSetting("owc-rail-collapsed") === "1");
  const [sendKey, setSendKeyState] = useState<SendKey>(loadSendKey);
  const [sessionDefaults, setSessionDefaultsState] = useState<SessionDefaults>(loadSessionDefaults);
  useEffect(() => storeSetting("owc-rail-width", String(railWidth)), [railWidth]);
  useEffect(() => storeSetting("owc-rail-collapsed", railCollapsed ? "1" : "0"), [railCollapsed]);
  const setSendKey = (value: SendKey): void => { setSendKeyState(value); saveSendKey(value); };
  const setSessionDefaults = (value: SessionDefaults): void => { setSessionDefaultsState(value); saveSessionDefaults(value); };
  // 草稿按会话保留，切换会话不丢
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 草稿附件也按会话隔离；异步发送完成只能清理自己的源会话。
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, PendingImage[]>>({});
  const [stream, setStream] = useState<Record<string, string>>({});
  const [thinkingStream, setThinkingStream] = useState<Record<string, string>>({});
  // WebSocket tokens often arrive in very small chunks. Buffer them outside
  // React and commit at most once per animation frame to avoid a page render
  // (and a full accumulated-string copy) for every token.
  const streamBuffers = useRef<Record<string, string[]>>({});
  const thinkingBuffers = useRef<Record<string, string[]>>({});
  const streamFlushHandle = useRef<number | undefined>(undefined);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [agentStates, setAgentStates] = useState<Record<string, string>>({});
  // agent.error 除了短暂 toast，也保留在当前会话的轨道中；下一次真正开始运行时再清除。
  const [runFailures, setRunFailures] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>();
  // 失败类提示用 error（红色、role=alert），成功/进度类用 info
  const notify = useCallback((text: string, kind: Notice["kind"] = "info"): void => setNotice({ kind, text }), []);
  const flushStreamBuffers = useCallback((): void => {
    streamFlushHandle.current = undefined;
    const text = streamBuffers.current;
    const thinking = thinkingBuffers.current;
    streamBuffers.current = {};
    thinkingBuffers.current = {};
    if (Object.keys(text).length) {
      setStream((previous) => {
        const next = { ...previous };
        for (const [id, chunks] of Object.entries(text)) next[id] = `${next[id] ?? ""}${chunks.join("")}`;
        return next;
      });
    }
    if (Object.keys(thinking).length) {
      setThinkingStream((previous) => {
        const next = { ...previous };
        for (const [id, chunks] of Object.entries(thinking)) next[id] = `${next[id] ?? ""}${chunks.join("")}`;
        return next;
      });
    }
  }, []);
  const queueStreamDelta = useCallback((sessionId: string, text: string, thinking = false): void => {
    const buffers = thinking ? thinkingBuffers.current : streamBuffers.current;
    (buffers[sessionId] ??= []).push(text);
    if (streamFlushHandle.current !== undefined) return;
    streamFlushHandle.current = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(flushStreamBuffers)
      : window.setTimeout(flushStreamBuffers, 80);
  }, [flushStreamBuffers]);
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions });
  const detail = useQuery({ queryKey: queryKeys.detail(currentId ?? ""), queryFn: () => api.session(currentId!), enabled: Boolean(currentId) });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const queue = useQuery({ queryKey: ["queue", currentId], queryFn: () => api.queue(currentId!), enabled: Boolean(currentId) });
  const interactions = useQuery({ queryKey: ["interactions", currentId], queryFn: () => api.interactions(currentId!), enabled: Boolean(currentId) });
  const contextView = useQuery({ queryKey: ["context", currentId], queryFn: () => api.context(currentId!), enabled: Boolean(currentId) });
  const skills = useQuery({ queryKey: queryKeys.skills(currentId ?? ""), queryFn: () => api.skills(currentId!), enabled: Boolean(currentId) });
  const todos = useQuery({ queryKey: ["todos", currentId], queryFn: () => api.todos(currentId!), enabled: Boolean(currentId) });
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  // 待确认权限以服务端为准（刷新后可恢复），WS 事件只作即时补充
  const serverPermissions = useQuery({ queryKey: ["permissions", currentId], queryFn: () => api.pendingPermissions(currentId!), enabled: Boolean(currentId) });
  const { data: currentRun, applyEvent: applyRunEvent } = useAgentRun(currentId);

  useEffect(() => {
    if (!currentId && sessions.data?.[0]) setCurrentId(sessions.data[0].id);
  }, [currentId, sessions.data]);

  const handleSessionEvent = useCallback((event: AppEvent): void => {
        applyRunEvent(event);
        if (event.type === "resync.required") {
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId ?? "") });
          queryClient.invalidateQueries({ queryKey: ["context", currentId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", currentId] });
          queryClient.invalidateQueries({ queryKey: ["todos", currentId] });
          queryClient.invalidateQueries({ queryKey: ["tasks", currentId] });
          if (currentId) queryClient.invalidateQueries({ queryKey: ["run", currentId] });
          return;
        }
        // agent.state 跨会话跟踪：驱动侧栏运行标记与头部状态徽章
        if (event.type === "agent.state" && event.sessionId) {
          const state = (event.payload as { state?: string }).state;
          if (state) {
            setAgentStates((prev) => ({ ...prev, [event.sessionId!]: state }));
            if (state === "thinking" || state === "starting" || state === "preparing_context") {
              setRunFailures((previous) => {
                if (!(event.sessionId! in previous)) return previous;
                const { [event.sessionId!]: _cleared, ...remaining } = previous;
                return remaining;
              });
            }
          }
        }
        if (event.type === "run.accepted" && event.sessionId) {
          setRunFailures((previous) => {
            if (!(event.sessionId! in previous)) return previous;
            const { [event.sessionId!]: _cleared, ...remaining } = previous;
            return remaining;
          });
        }
        if (event.type === "agent.error" && event.sessionId) {
          const message = (event.payload as { message?: string }).message ?? t("未知错误", "unknown error");
          setRunFailures((previous) => ({ ...previous, [event.sessionId!]: message }));
        }
        // 全局配置/目录事件无 sessionId，必须在按会话过滤之前处理。
        if (event.type === "server.settings_updated") {
          queryClient.invalidateQueries({ queryKey: ["providers"] });
          queryClient.invalidateQueries({ queryKey: ["settings"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
          if (currentId) queryClient.invalidateQueries({ queryKey: ["context", currentId] });
        }
        if (event.type === "models.updated") {
          queryClient.invalidateQueries({ queryKey: ["models"] });
          queryClient.invalidateQueries({ queryKey: ["settings"] });
        }
        if (event.type === "provider_profiles.updated") {
          queryClient.invalidateQueries({ queryKey: ["provider-profiles"] });
          queryClient.invalidateQueries({ queryKey: ["providers"] });
          queryClient.invalidateQueries({ queryKey: ["models"] });
          queryClient.invalidateQueries({ queryKey: ["settings"] });
        }
        // MCP server 连接失败降级：该 server 工具未注入，给出告警
        if (event.type === "mcp.degraded" && event.sessionId === currentId) {
          notify((event.payload as { message?: string }).message ?? t("MCP server 降级", "MCP server degraded"), "error");
        }
        // 上下文清空（/clear 命令）：刷新会话详情与上下文面板并提示
        if (event.type === "context.cleared" && event.sessionId && event.sessionId === currentId) {
          notify(t("上下文已清空（历史保留）", "Context cleared (history retained)"));
        }
        // 上下文压缩（手动/85% 强制）：刷新上下文面板并提示
        if (event.type === "context.compacted" && event.sessionId === currentId) {
          const payload = event.payload as { mode?: string; forced?: boolean };
          const modeLabel = payload.mode === "overview" ? t("概览", "overview") : payload.mode === "toolcalls" ? t("工具调用", "tool calls") : t("规则截断", "rule-based truncation");
          notify(t(`已压缩上下文（${payload.forced ? "85% 水位强制 · " : ""}${modeLabel}）`, `Context compacted (${payload.forced ? "forced at 85% · " : ""}${modeLabel})`));
        }
        if (event.type === "context.compact_failed" && event.sessionId === currentId) {
          notify(t(`上下文压缩失败：${(event.payload as { message?: string }).message ?? "未知错误"}`, `Context compaction failed: ${(event.payload as { message?: string }).message ?? "unknown error"}`), "error");
        }
        if (!event.sessionId || event.sessionId !== currentId) return;
        if (event.type === "checkpoint.failed") {
          const message = (event.payload as { message?: string }).message ?? t("未知错误", "unknown error");
          notify(t(
            `自动快照失败，但本次消息仍会继续发送：${message}。可切换为“仅手动”，或使用具备快照权限的账户重试。`,
            `Automatic snapshot failed, but this message will still be sent: ${message}. Switch to Manual only or retry with an account that has snapshot permission.`,
          ), "error");
        }
        if (event.type === "agent.error") {
          const message = (event.payload as { message?: string }).message ?? t("未知错误", "unknown error");
          notify(t(`任务失败：${message}`, `Task failed: ${message}`), "error");
        }
        if (event.type === "todos.updated") {
          queryClient.setQueryData<TodoItem[]>(["todos", event.sessionId], (event.payload as { items?: TodoItem[] }).items ?? []);
        }
        if (event.type === "message.delta") {
          const text = (event.payload as { text?: string }).text ?? "";
          queueStreamDelta(event.sessionId!, text);
        }
        if (event.type === "message.thinking_delta") {
          const text = (event.payload as { text?: string }).text ?? "";
          queueStreamDelta(event.sessionId!, text, true);
        }
        if (event.type === "permission.request") {
          const req = event.payload as PermissionRequest;
          setPendingPermissions((prev) => [...prev.filter((item) => item.requestId !== req.requestId), req]);
          queryClient.invalidateQueries({ queryKey: ["permissions", event.sessionId] });
        }
        if (event.type.startsWith("queue.") || event.type.startsWith("steering.")) {
          queryClient.invalidateQueries({ queryKey: ["queue", event.sessionId] });
        }
        if (event.type.startsWith("interaction.")) queryClient.invalidateQueries({ queryKey: ["interactions", event.sessionId] });
        // 后台任务完成通知：刷新任务列表
        if (event.type === "task.finished") {
          const task = event.payload as BackgroundTaskInfo;
          notify(t(`后台任务 ${task.taskId} 已结束（exit ${task.exitCode ?? "?"}）`, `Background task ${task.taskId} finished (exit ${task.exitCode ?? "?"})`));
          queryClient.invalidateQueries({ queryKey: ["tasks", currentId] });
        }
        const refreshDetail = ["agent.state", "tool.end", "agent.error", "session.config_updated"].includes(event.type);
        const refreshContext = ["context.usage", "context.budget_updated", "context.restored", "context.evicted", "context.compacted", "context.cleared"].includes(event.type);
        const refreshCheckpoints = ["checkpoint.created", "checkpoint.restored", "checkpoint.deleted", "checkpoint.failed"].includes(event.type);
        if (refreshDetail || refreshContext || refreshCheckpoints) {
          const detailRefresh = refreshDetail
            ? queryClient.invalidateQueries({ queryKey: queryKeys.detail(event.sessionId) })
            : Promise.resolve();
          if (refreshContext) queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
          if (refreshCheckpoints) queryClient.invalidateQueries({ queryKey: ["checkpoints", event.sessionId] });
          if (event.type === "agent.state" && (event.payload as { state?: string }).state === "idle") {
            flushStreamBuffers();
            // 等持久化消息重新拉取完成后再撤掉临时流，避免思考/正文在切换到历史卡片时闪烁或消失。
            void detailRefresh.finally(() => {
              setStream((value) => ({ ...value, [event.sessionId!]: "" }));
              setThinkingStream((value) => ({ ...value, [event.sessionId!]: "" }));
            });
          }
        }
  }, [applyRunEvent, currentId, flushStreamBuffers, notify, queryClient, queueStreamDelta, t]);
  const finishBufferedStreams = useCallback((): void => {
    if (streamFlushHandle.current !== undefined) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(streamFlushHandle.current);
      else window.clearTimeout(streamFlushHandle.current);
    }
    flushStreamBuffers();
  }, [flushStreamBuffers]);
  useSessionEventStream({ sessionId: currentId, onEvent: handleSessionEvent, onDisconnect: finishBufferedStreams });

  const current = detail.data;
  const currentState = currentRun?.state ?? (currentId ? agentStates[currentId] : undefined);
  const running = Boolean(stream[currentId ?? ""]) || isBusyState(currentState);
  const runningIds = useMemo(
    () => new Set(Object.entries(agentStates).filter(([, state]) => isBusyState(state)).map(([id]) => id)),
    [agentStates],
  );
  // 切换会话后丢弃上一会话的 WS 即时权限卡，改由服务端列表播种
  useEffect(() => setPendingPermissions([]), [currentId]);
  const mergedPermissions = useMemo(() => {
    const server = serverPermissions.data ?? [];
    const local = pendingPermissions.filter((item) => !server.some((entry) => entry.requestId === item.requestId));
    return [...server, ...local];
  }, [serverPermissions.data, pendingPermissions]);

  const draft = currentId ? (drafts[currentId] ?? "") : "";
  const attachments = currentId ? (attachmentsBySession[currentId] ?? []) : [];
  const setAttachments = (value: PendingImage[] | ((previous: PendingImage[]) => PendingImage[])): void => {
    if (!currentId) return;
    setAttachmentsBySession((previous) => {
      const currentAttachments = previous[currentId] ?? [];
      const next = typeof value === "function" ? value(currentAttachments) : value;
      return { ...previous, [currentId]: next };
    });
  };
  const setDraft = (value: string): void => {
    if (currentId) setDrafts((prev) => ({ ...prev, [currentId]: value }));
  };

  const costSummary = useMemo(() => {
    const ledger = contextView.data?.ledger;
    if (!ledger || !contextView.data) return undefined;
    const currency = contextView.data.preferences.currency;
    return {
      tokens: ledger.usage.inputTokens + ledger.usage.outputTokens,
      costLabel: formatCurrency(currency === "CNY" ? ledger.cost.cnyMicroUnits : ledger.cost.usdMicroUnits, currency),
      tokenBudget: ledger.policy?.maxSessionTokens,
      paused: currentState === "budget_paused",
    };
  }, [contextView.data, currentState]);

  const send = useMutation({
    mutationFn: async (input: { sessionId: string; text: string; images: PendingImage[]; pathAttachments: ReturnType<typeof toAttachments>; behavior: "start" | "steer" | "follow_up" }) => {
      const { sessionId, text, images, pathAttachments, behavior } = input;
      // `!` 前缀走 shell 快捷路由：不进 agent run，权限挂起时后端 409 由 onError 提示
      if (text.startsWith("!")) return api.runShell(sessionId, text.slice(1).trim());
      return api.sendMessage(sessionId, text, images, pathAttachments.length ? pathAttachments : undefined, behavior);
    },
    onSuccess: (result, input) => {
      setDrafts((previous) => ({ ...previous, [input.sessionId]: "" }));
      setAttachmentsBySession((previous) => ({ ...previous, [input.sessionId]: [] }));
      const queued = result as { queued?: boolean; position?: number } | undefined;
      if (queued?.queued) notify(input.behavior === "follow_up"
        ? t(`已加入完成后续跑队列（第 ${queued.position} 项）`, `Added to follow-up queue (position ${queued.position})`)
        : t(`已加入 Steering 队列（第 ${queued.position} 项）`, `Added to Steering queue (position ${queued.position})`));
      queryClient.invalidateQueries({ queryKey: queryKeys.detail(input.sessionId) });
    },
    onError: (error) => notify(error instanceof Error ? error.message : t("发送失败", "Send failed"), "error"),
  });

  // 托管工作区的镜像盘快照必须由用户显式触发；服务端仍会拒绝运行中或同步中的会话。
  const manualSnapshot = useMutation({
    mutationFn: (sessionId: string) => api.createCheckpoint(sessionId, t("手动虚拟磁盘快照", "Manual virtual disk snapshot")),
    onSuccess: (checkpoint, sessionId) => {
      notify(t(`已创建虚拟磁盘快照「${checkpoint.label}」`, `Virtual disk snapshot “${checkpoint.label}” created`));
      void queryClient.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.detail(sessionId) });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("未知错误", "unknown error");
      notify(t(`创建虚拟磁盘快照失败：${message}`, `Could not create virtual disk snapshot: ${message}`), "error");
    },
  });

  // shell 结果卡「发给 agent」：把 `!cmd` 与输出摘要作为普通用户消息送入 agent run
  const sendShellToAgent = (cmd: string, output: string): void => {
    if (!currentId) return;
    const summary = output.length > 2000 ? t(`${output.slice(0, 2000)}\n…（输出已截断）`, `${output.slice(0, 2000)}\n…(output truncated)`) : output;
    api.sendMessage(currentId, t(`刚才执行的 shell 命令：\n${cmd}\n\n输出：\n${summary}`, `Shell command just executed:\n${cmd}\n\nOutput:\n${summary}`))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId) }))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("发送失败", "Send failed"), "error"));
  };

  const create = useMutation({
    mutationFn: (values: NewSessionValues) => api.createSession(values),
    onSuccess: (session, values) => {
      setDialogOpen(false);
      setCurrentId(session.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      // 权限模式不在创建接口内，创建后单独应用
      if (values.permissionMode && values.permissionMode !== "ask") {
        api.updateSession(session.id, { permissionMode: values.permissionMode })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(session.id) }))
          .catch((error: unknown) => notify(error instanceof Error ? error.message : t("权限模式应用失败", "Could not apply permission mode"), "error"));
      }
    },
    onError: (error) => notify(error instanceof Error ? error.message : t("创建会话失败", "Could not create session"), "error"),
  });

  const removeSession = (id: string): void => {
    const target = sessions.data?.find((session) => session.id === id);
    const runningPrefix = runningIds.has(id) ? t("该会话正在运行，", "This session is running. ") : "";
    if (!window.confirm(t(`${runningPrefix}删除会话「${target?.title ?? id}」？该操作不可撤销。`, `${runningPrefix}Delete session “${target?.title ?? id}”? This cannot be undone.`))) return;
    api.deleteSession(id)
      .then(() => {
        if (currentId === id) setCurrentId(sessions.data?.find((session) => session.id !== id)?.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("删除会话失败", "Could not delete session"), "error"));
  };

  const importSession = (file: File): void => {
    file.text()
      .then((text) => api.importSession(text))
      .then((session) => {
        notify(t(`已导入会话「${session.title}」`, `Imported session “${session.title}”`));
        setCurrentId(session.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("导入失败", "Import failed"), "error"));
  };

  const model = useMemo(() => models.data?.find((item) => item.id === current?.model && item.provider === current?.provider), [models.data, current?.model, current?.provider]);
  // 模型档案缺 modalities 字段时按不支持图片处理（服务端仍会二次校验）
  const supportsImages = model?.capabilities.modalities?.includes("image") ?? false;

  const resetLayout = (): void => {
    for (const key of ["owc-rail-width", "owc-rail-collapsed", "owc-panel-tab", "owc-panel-open", "owc-panel-height"]) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
    window.location.reload();
  };

  return (
    <main
      className="console-shell"
      style={{ gridTemplateColumns: railCollapsed ? "56px minmax(0, 1fr)" : `${railWidth}px minmax(0, 1fr)` }}
    >
      <SessionRail
        sessions={sessions.data}
        currentId={currentId}
        runningIds={runningIds}
        theme={theme}
        collapsed={railCollapsed}
        width={railWidth}
        onSelect={setCurrentId}
        onCreate={() => setDialogOpen(true)}
        onDelete={removeSession}
        onImport={importSession}
        onToggleTheme={toggleTheme}
        onToggleCollapsed={() => setRailCollapsed((value) => !value)}
        onOpenSettings={() => setSettingsOpen(true)}
        onResize={setRailWidth}
      />
      <section className="workbench">
        {current ? (
          <>
            <JobHeader
              session={current}
              agentState={currentState}
              costSummary={costSummary}
              onAbort={() => api.abort(current.id).catch((error: unknown) => notify(error instanceof Error ? error.message : t("无法中断", "Could not stop the job"), "error"))}
              onConfig={(body) => api.updateSession(current.id, body)
                .then((updated) => {
                  queryClient.setQueryData<SessionDetail>(queryKeys.detail(current.id), (previous) => previous ? { ...previous, ...updated } : previous);
                  void queryClient.invalidateQueries({ queryKey: queryKeys.detail(current.id) });
                  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
                })
                .catch((error: unknown) => {
                  notify(error instanceof Error ? error.message : t("模式切换失败", "Mode change failed"), "error");
                })}
              onCreateCheckpoint={() => manualSnapshot.mutate(current.id)}
              checkpointPending={manualSnapshot.isPending}
              running={running}
            />
            {todos.data && todos.data.length > 0 && (
              <details className="todo-panel" open>
                <summary>{t("任务清单", "Task list")} · {todos.data.filter((item) => item.status === "done").length}/{todos.data.length}</summary>
                <ul>{todos.data.map((item, index) => (
                  <li key={`${item.content}-${index}`} data-status={item.status}>
                    <span>{item.status === "done" ? "✓" : item.status === "in_progress" ? "●" : "○"}</span>
                    {item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}
                  </li>
                ))}</ul>
              </details>
            )}
            <ExecutionTrack
              session={current}
              contentLens={extensions.data?.find((extension) => extension.id === "content-lens" && extension.enabled)}
              onNotice={notify}
              {...(contextView.data?.ledger.cleared ? { cleared: contextView.data.ledger.cleared } : {})}
              streamText={stream[current.id] ?? ""}
              thinkingText={thinkingStream[current.id] ?? ""}
              runError={runFailures[current.id]}
              permissions={mergedPermissions}
              onSendToAgent={sendShellToAgent}
              onPermissionDone={(requestId) => {
                setPendingPermissions((prev) => prev.filter((item) => item.requestId !== requestId));
                queryClient.invalidateQueries({ queryKey: ["permissions", current.id] });
              }}
              onPermissionError={(message) => notify(message, "error")}
            />
            {queue.data?.some((item) => item.status === "queued") && (
              <SteeringQueue
                items={queue.data}
                onRemove={(itemId) => api.removeQueue(current.id, itemId)
                  .then(() => queue.refetch())
                  .catch((error: unknown) => notify(error instanceof Error ? error.message : t("撤销 Steering 失败", "Could not remove Steering item"), "error"))}
              />
            )}
            {interactions.data?.filter((item) => item.status === "pending").map((item) => (
              <InteractionCard key={item.id} item={item} onRespond={(answer) => api.respondInteraction(current.id, item.id, answer)
                .then(() => interactions.refetch())
                .catch((error: unknown) => notify(error instanceof Error ? error.message : t("提交回答失败", "Could not submit answer"), "error"))} />
            ))}
            <Composer
              current={current}
              model={model}
              models={models.data ?? []}
              providers={providers.data ?? []}
              pdfToImageExtension={extensions.data?.find((extension) => extension.id === "pdf-to-image")}
              pdfToImageStatus={extensions.isPending ? "loading" : extensions.isError ? "unavailable" : "ready"}
              imageCapabilitiesReady={!models.isPending}
              draft={draft}
              setDraft={setDraft}
              onSend={(behavior = running ? "steer" : "start") => {
                if (!currentId || !draft.trim()) return;
                const text = draft.trim();
                send.mutate({ sessionId: currentId, text, images: attachments, pathAttachments: toAttachments(extractAttachmentPaths(text)), behavior });
              }}
              onConfig={(body) => {
                api.updateSession(current.id, body)
                  .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(current.id) }))
                  .catch((error: unknown) => notify(error instanceof Error ? error.message : t("配置失败", "Configuration failed"), "error"));
              }}
              running={running}
              sendPending={send.isPending}
              sendKey={sendKey}
              skills={skills.data?.skills ?? []}
              attachments={attachments}
              setAttachments={setAttachments}
              supportsImages={supportsImages}
              onNotice={(message, kind = "info") => notify(message, kind)}
            />
            <StatusBar session={current} state={currentState} tokens={costSummary?.tokens} costLabel={costSummary?.costLabel} />
          </>
        ) : (
          <EmptyState sessions={sessions.data ?? []} onSelect={setCurrentId} onCreate={() => setDialogOpen(true)} />
        )}
        <BottomPanel sessionId={currentId} session={current} running={running} onNotice={notify} />
      </section>
      <NewSessionDialog
        open={dialogOpen}
        providers={providers.data ?? []}
        models={models.data ?? []}
        defaults={sessionDefaults}
        busy={create.isPending}
        onClose={() => setDialogOpen(false)}
        onCreate={(values) => create.mutate(values)}
      />
      <SettingsDialog
        open={settingsOpen}
        preference={preference}
        setPreference={setPreference}
        accent={accent}
        setAccent={setAccent}
        sendKey={sendKey}
        setSendKey={setSendKey}
        defaults={sessionDefaults}
        setDefaults={setSessionDefaults}
        providers={providers.data ?? []}
        models={models.data ?? []}
        onResetLayout={resetLayout}
        onClose={() => setSettingsOpen(false)}
      />
      {notice && <Toast notice={notice} onDismiss={() => setNotice(undefined)} />}
    </main>
  );
}
