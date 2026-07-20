import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { extractAttachmentPaths, toAttachments } from "./lib/attachments";
import type { AppEvent, BackgroundTaskInfo, SessionDetail, TodoItem } from "./lib/contracts";
import { formatCurrency } from "./lib/format";
import { loadSendKey, loadSessionDefaults, saveSendKey, saveSessionDefaults, type SendKey, type SessionDefaults } from "./lib/prefs";
import { useTheme } from "./theme";
import { BottomPanel } from "./components/BottomPanel";
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
  // 待发送的图片附件（仅当前会话；发送成功或切换会话后清空）
  const [attachments, setAttachments] = useState<PendingImage[]>([]);
  const [stream, setStream] = useState<Record<string, string>>({});
  const [thinkingStream, setThinkingStream] = useState<Record<string, string>>({});
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [agentStates, setAgentStates] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>();
  // 失败类提示用 error（红色、role=alert），成功/进度类用 info
  const notify = (text: string, kind: Notice["kind"] = "info"): void => setNotice({ kind, text });
  const sessionEventSeq = useRef<Record<string, number>>({});
  const globalSeq = useRef(0);
  const activeSeq = Math.max(currentId ? (sessionEventSeq.current[currentId] ?? 0) : 0, globalSeq.current);

  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions });
  const detail = useQuery({ queryKey: queryKeys.detail(currentId ?? ""), queryFn: () => api.session(currentId!), enabled: Boolean(currentId) });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const steering = useQuery({ queryKey: ["steering", currentId], queryFn: () => api.steering(currentId!), enabled: Boolean(currentId) });
  const contextView = useQuery({ queryKey: ["context", currentId], queryFn: () => api.context(currentId!), enabled: Boolean(currentId) });
  const skills = useQuery({ queryKey: queryKeys.skills(currentId ?? ""), queryFn: () => api.skills(currentId!), enabled: Boolean(currentId) });
  const todos = useQuery({ queryKey: ["todos", currentId], queryFn: () => api.todos(currentId!), enabled: Boolean(currentId) });
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  // 待确认权限以服务端为准（刷新后可恢复），WS 事件只作即时补充
  const serverPermissions = useQuery({ queryKey: ["permissions", currentId], queryFn: () => api.pendingPermissions(currentId!), enabled: Boolean(currentId) });

  useEffect(() => {
    if (!currentId && sessions.data?.[0]) setCurrentId(sessions.data[0].id);
  }, [currentId, sessions.data]);

  // 切换会话时清空未发送的图片附件
  useEffect(() => setAttachments([]), [currentId]);

  useEffect(() => {
    let retry = 0;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    const connect = (): void => {
      const query = new URLSearchParams({ after: String(activeSeq), ...(currentId ? { sessionId: currentId } : {}) });
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?${query}`);
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as AppEvent;
        // connected/resync 等无 seq 帧不算真实事件，跳过水位推进
        if (typeof event.seq === "number" && event.seq > globalSeq.current) globalSeq.current = event.seq;
        if (event.sessionId && event.seq > (sessionEventSeq.current[event.sessionId] ?? 0)) {
          sessionEventSeq.current = { ...sessionEventSeq.current, [event.sessionId]: event.seq };
        }
        if (event.type === "resync.required") {
          if (typeof event.seq === "number" && event.seq > globalSeq.current) globalSeq.current = event.seq;
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId ?? "") });
          queryClient.invalidateQueries({ queryKey: ["context", currentId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", currentId] });
          queryClient.invalidateQueries({ queryKey: ["todos", currentId] });
          queryClient.invalidateQueries({ queryKey: ["tasks", currentId] });
          return;
        }
        // agent.state 跨会话跟踪：驱动侧栏运行标记与头部状态徽章
        if (event.type === "agent.state" && event.sessionId) {
          const state = (event.payload as { state?: string }).state;
          if (state) setAgentStates((prev) => ({ ...prev, [event.sessionId!]: state }));
        }
        // server.settings_updated / models.updated 无 sessionId，必须在按会话过滤之前处理
        if (event.type === "server.settings_updated") {
          queryClient.invalidateQueries({ queryKey: ["providers"] });
          queryClient.invalidateQueries({ queryKey: ["settings"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
          if (currentId) queryClient.invalidateQueries({ queryKey: ["context", currentId] });
        }
        if (event.type === "models.updated") {
          queryClient.invalidateQueries({ queryKey: ["models"] });
        }
        // MCP server 连接失败降级：该 server 工具未注入，给出告警
        if (event.type === "mcp.degraded" && event.sessionId === currentId) {
          notify((event.payload as { message?: string }).message ?? "MCP server 降级", "error");
        }
        // 上下文清空（/clear 命令）：刷新会话详情与上下文面板并提示
        if (event.type === "context.cleared" && event.sessionId && event.sessionId === currentId) {
          notify("上下文已清空（历史保留）");
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(event.sessionId) });
          queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
        }
        // 上下文压缩（手动/85% 强制）：刷新上下文面板并提示
        if (event.type === "context.compacted" && event.sessionId === currentId) {
          const payload = event.payload as { mode?: string; forced?: boolean };
          const modeLabel = payload.mode === "overview" ? "概览" : payload.mode === "toolcalls" ? "工具调用" : "规则截断";
          notify(`已压缩上下文（${payload.forced ? "85% 水位强制 · " : ""}${modeLabel}）`);
          queryClient.invalidateQueries({ queryKey: ["context", currentId] });
        }
        if (event.type === "context.compact_failed" && event.sessionId === currentId) {
          notify(`上下文压缩失败：${(event.payload as { message?: string }).message ?? "未知错误"}`, "error");
        }
        if (!event.sessionId || event.sessionId !== currentId) return;
        if (event.type === "todos.updated") {
          queryClient.setQueryData<TodoItem[]>(["todos", event.sessionId], (event.payload as { items?: TodoItem[] }).items ?? []);
        }
        if (event.type === "message.delta") {
          const text = (event.payload as { text?: string }).text ?? "";
          setStream((value) => ({ ...value, [event.sessionId!]: `${value[event.sessionId!] ?? ""}${text}` }));
        }
        if (event.type === "message.thinking_delta") {
          const text = (event.payload as { text?: string }).text ?? "";
          setThinkingStream((value) => ({ ...value, [event.sessionId!]: `${value[event.sessionId!] ?? ""}${text}` }));
        }
        if (event.type === "permission.request") {
          const req = event.payload as PermissionRequest;
          setPendingPermissions((prev) => [...prev.filter((item) => item.requestId !== req.requestId), req]);
          queryClient.invalidateQueries({ queryKey: ["permissions", event.sessionId] });
        }
        if (["steering.queued", "steering.applied", "steering.removed"].includes(event.type)) {
          queryClient.invalidateQueries({ queryKey: ["steering", event.sessionId] });
        }
        // 后台任务完成通知：刷新任务列表
        if (event.type === "task.finished") {
          const task = event.payload as BackgroundTaskInfo;
          notify(`后台任务 ${task.taskId} 已结束（exit ${task.exitCode ?? "?"}）`);
          queryClient.invalidateQueries({ queryKey: ["tasks", currentId] });
        }
        if ([
          "agent.state", "tool.end", "checkpoint.created", "checkpoint.restored", "checkpoint.deleted", "context.usage",
          "context.budget_updated", "context.restored", "session.config_updated",
        ].includes(event.type)) {
          const detailRefresh = queryClient.invalidateQueries({ queryKey: queryKeys.detail(event.sessionId) });
          queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", event.sessionId] });
          queryClient.invalidateQueries({ queryKey: ["permissions", event.sessionId] });
          if (event.type === "agent.state" && (event.payload as { state?: string }).state === "idle") {
            // 等持久化消息重新拉取完成后再撤掉临时流，避免思考/正文在切换到历史卡片时闪烁或消失。
            void detailRefresh.finally(() => {
              setStream((value) => ({ ...value, [event.sessionId!]: "" }));
              setThinkingStream((value) => ({ ...value, [event.sessionId!]: "" }));
            });
          }
        }
      };
      socket.onclose = () => {
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => { socket?.close(); if (timer) window.clearTimeout(timer); };
  }, [currentId, queryClient]);

  const current = detail.data;
  const currentState = currentId ? agentStates[currentId] : undefined;
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
    mutationFn: async () => {
      if (!currentId || !draft.trim()) return;
      const text = draft.trim();
      // `!` 前缀走 shell 快捷路由：不进 agent run，权限挂起时后端 409 由 onError 提示
      if (text.startsWith("!")) return api.runShell(currentId, text.slice(1).trim());
      const pathAttachments = toAttachments(extractAttachmentPaths(text));
      return api.sendMessage(currentId, text, attachments, pathAttachments.length ? pathAttachments : undefined);
    },
    onSuccess: (result) => {
      setDraft("");
      setAttachments([]);
      const queued = result as { queued?: boolean; position?: number } | undefined;
      if (queued?.queued) notify(`已加入 Steering 队列（第 ${queued.position} 项）`);
      queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId ?? "") });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "发送失败", "error"),
  });

  // shell 结果卡「发给 agent」：把 `!cmd` 与输出摘要作为普通用户消息送入 agent run
  const sendShellToAgent = (cmd: string, output: string): void => {
    if (!currentId) return;
    const summary = output.length > 2000 ? `${output.slice(0, 2000)}\n…（输出已截断）` : output;
    api.sendMessage(currentId, `刚才执行的 shell 命令：\n${cmd}\n\n输出：\n${summary}`)
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId) }))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "发送失败", "error"));
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
          .catch((error: unknown) => notify(error instanceof Error ? error.message : "权限模式应用失败", "error"));
      }
    },
    onError: (error) => notify(error instanceof Error ? error.message : "创建会话失败", "error"),
  });

  const removeSession = (id: string): void => {
    const target = sessions.data?.find((session) => session.id === id);
    const runningPrefix = runningIds.has(id) ? "该会话正在运行，" : "";
    if (!window.confirm(`${runningPrefix}删除会话「${target?.title ?? id}」？该操作不可撤销。`)) return;
    api.deleteSession(id)
      .then(() => {
        if (currentId === id) setCurrentId(sessions.data?.find((session) => session.id !== id)?.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "删除会话失败", "error"));
  };

  const importSession = (file: File): void => {
    file.text()
      .then((text) => api.importSession(text))
      .then((session) => {
        notify(`已导入会话「${session.title}」`);
        setCurrentId(session.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "导入失败", "error"));
  };

  const model = useMemo(() => models.data?.find((item) => item.id === current?.model), [models.data, current?.model]);
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
              onAbort={() => api.abort(current.id).catch((error: unknown) => notify(error instanceof Error ? error.message : "无法中断", "error"))}
              onConfig={(body) => api.updateSession(current.id, body)
                .then((updated) => {
                  queryClient.setQueryData<SessionDetail>(queryKeys.detail(current.id), (previous) => previous ? { ...previous, ...updated } : previous);
                  void queryClient.invalidateQueries({ queryKey: queryKeys.detail(current.id) });
                  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
                })
                .catch((error: unknown) => {
                  notify(error instanceof Error ? error.message : "模式切换失败", "error");
                })}
            />
            {todos.data && todos.data.length > 0 && (
              <details className="todo-panel" open>
                <summary>任务清单 · {todos.data.filter((item) => item.status === "done").length}/{todos.data.length}</summary>
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
              permissions={mergedPermissions}
              onSendToAgent={sendShellToAgent}
              onPermissionDone={(requestId) => {
                setPendingPermissions((prev) => prev.filter((item) => item.requestId !== requestId));
                queryClient.invalidateQueries({ queryKey: ["permissions", current.id] });
              }}
              onPermissionError={(message) => notify(message, "error")}
            />
            {steering.data && steering.data.length > 0 && (
              <SteeringQueue
                items={steering.data}
                onRemove={(itemId) => api.removeSteering(current.id, itemId)
                  .then(() => steering.refetch())
                  .catch((error: unknown) => notify(error instanceof Error ? error.message : "撤销 Steering 失败", "error"))}
              />
            )}
            <Composer
              current={current}
              model={model}
              models={models.data ?? []}
              draft={draft}
              setDraft={setDraft}
              onSend={() => send.mutate()}
              onConfig={(body) => {
                api.updateSession(current.id, body)
                  .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(current.id) }))
                  .catch((error: unknown) => notify(error instanceof Error ? error.message : "配置失败", "error"));
              }}
              running={running}
              sendPending={send.isPending}
              sendKey={sendKey}
              skills={skills.data?.skills ?? []}
              attachments={attachments}
              setAttachments={setAttachments}
              supportsImages={supportsImages}
              onNotice={(message) => notify(message, "error")}
            />
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
