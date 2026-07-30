import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { extractAttachmentPaths, toAttachments } from "./lib/attachments";
import type { AgentErrorPayload, AppEvent, BackgroundTaskInfo, ChatMessage, ContextUsage, ContextWatermark, SessionDetail, TodoItem, WorkspaceIndexStatus } from "./lib/contracts";
import { agentErrorToastText } from "./lib/agent-error";
import { deriveWindowInfo } from "./lib/context-window";
import { formatCurrency } from "./lib/format";
import { loadSendKey, loadSessionDefaults, saveSendKey, saveSessionDefaults, type SendKey, type SessionDefaults } from "./lib/prefs";
import { loadDraft, pruneDrafts, saveDraft } from "./lib/drafts";
import { writeClipboard } from "./lib/clipboard";
import { deriveInputHistory } from "./lib/input-history";
import { useTheme } from "./theme";
import { useAgentRun } from "./hooks/use-agent-run";
import { useLiveActivity, type LiveActivityInfo } from "./hooks/use-live-activity";
import { useLiveSubagents } from "./hooks/use-live-subagents";
import { useSubagentTabs } from "./hooks/use-subagent-tabs";
import { useTerminalTabs } from "./hooks/use-terminal-tabs";
import { deriveSubagentRunsFromMessages, mergeSubagentRuns } from "./lib/subagent-runs";
import { useSessionEventStream } from "./hooks/use-session-event-stream";
import { useStreamBuffers } from "./hooks/use-stream-buffers";
import { applyDiagnosticsBadgeUpdate, clearDiagnosticsBadge } from "./lib/diagnostics";
import { BottomPanel } from "./components/BottomPanel";
import { StatusBar } from "./components/StatusBar";
import { InteractionCard } from "./components/InteractionCard";
import { Composer } from "./components/Composer";
import type { PendingImage } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { SessionSkeleton } from "./components/SessionSkeleton";
import { ExecutionTrack } from "./components/ExecutionTrack";
import { CONVERSATION_SEARCH_EVENT } from "./components/ConversationSearch";
import { SubagentTabStrip } from "./components/SubagentTabStrip";
import { SubagentTabView } from "./components/SubagentTabView";
import { TerminalView } from "./components/TerminalView";
import { JobHeader } from "./components/JobHeader";
import { isBusyState, INACTIVE_STATES } from "./lib/agent-state";
import { NewSessionDialog, type NewSessionValues } from "./components/NewSessionDialog";
import { ConfirmDeleteDialog } from "./components/ConfirmDeleteDialog";
import type { PermissionRequest } from "./components/PermissionCard";
import { SessionRail } from "./components/SessionRail";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { SteeringQueue } from "./components/SteeringQueue";
import { Toast, type Notice } from "./components/Toast";
import { useI18n } from "./i18n";
import {
  clearNotifications, markAllRead, markRead, pushNotification, removeNotification, unreadCount,
  type AppNotification,
} from "./lib/notifications";
import { MOBILE_BREAKPOINT, useMediaQuery } from "./hooks/use-media-query";
// 0.4.0 Phase 5a：五区布局与命令体系
import { ActivityBar } from "./workbench/ActivityBar";
import { SidebarPanel } from "./workbench/SidebarPanel";
import { WorkbenchShell, CYCLE_ZONE_EVENT } from "./workbench/WorkbenchShell";
import { LAYOUT_STORAGE_KEYS, useWorkbenchLayout, type SidebarView } from "./workbench/useWorkbenchLayout";
import { registerBuiltinCommands, type CommandActions } from "./commands/builtin";
import type { WhenContext } from "./commands/registry";
import { useGlobalKeybindings } from "./commands/useKeybindings";

// 覆盖层各自独立 chunk，仅打开时加载，不占入口体积
const CommandPalette = lazy(() => import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const QuickOpen = lazy(() => import("./components/QuickOpen").then((m) => ({ default: m.QuickOpen })));
const ShortcutsDialog = lazy(() => import("./components/ShortcutsDialog").then((m) => ({ default: m.ShortcutsDialog })));
const CodeOverlay = lazy(() => import("./components/CodeOverlay").then((m) => ({ default: m.CodeOverlay })));
const NotificationsOverlay = lazy(() => import("./components/NotificationsOverlay").then((m) => ({ default: m.NotificationsOverlay })));
// 编辑器分栏（0.5.0 Phase 1a）：组件自身懒加载；Monaco 在其内部再经 monaco-loader 动态 import（独立 chunk）
const EditorPane = lazy(() => import("./components/editor/EditorPane").then((m) => ({ default: m.EditorPane })));
// 统一 diff 视图（0.5.0 Phase 1b）：SCM/检查点/工具改动三来源同一组件，复用编辑器分栏机制
const DiffPane = lazy(() => import("./components/editor/DiffPane").then((m) => ({ default: m.DiffPane })));
import type { DiffSpec } from "./components/editor/DiffPane";

const queryKeys = { sessions: ["sessions"] as const, detail: (id: string) => ["session", id] as const, skills: (id: string) => ["skills", id] as const };

export function App(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { theme, preference, setPreference, toggleTheme, accent, setAccent } = useTheme();
  const [currentId, setCurrentId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 设置深链目标页签 + 触发序号（同一页签重复深链也能重新定位）；undefined 表示保持上次使用的页签
  const [settingsTab, setSettingsTab] = useState<{ tab: SettingsTab; at: number } | undefined>();
  const openSettings = useCallback((tab?: SettingsTab): void => {
    setSettingsTab(tab === undefined ? undefined : { tab, at: Date.now() });
    setSettingsOpen(true);
  }, []);
  // 覆盖层（Phase 5a）：命令面板 / Quick Open / 快捷键速查 / 只读代码视图浮层
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [codeOverlayPath, setCodeOverlayPath] = useState<string>();
  // 编辑器分栏（0.5.0 Phase 1a）：对话的辅助视图，随需打开、Esc 即回对话；不持久化，新会话默认无编辑器
  const [editorPane, setEditorPane] = useState<{ path: string; line?: number; column?: number }>();
  // 统一 diff 视图（0.5.0 Phase 1b）：与编辑器分栏互斥（同屏最多一个辅助视图），同样随需打开、切换会话即关闭
  const [diffPane, setDiffPane] = useState<DiffSpec>();
  // 通知中心（Phase 5b §6.6）：toast 与后台事件汇总为可回看列表
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  // 0.5.0 Phase 2：会话消息分页——在初始页之前加载的更早消息
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 移动端（Phase 5b §6.8）：CSS 媒体查询为主判定，JS 仅做状态联动（选中会话收起抽屉）
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const importInput = useRef<HTMLInputElement>(null);
  const layout = useWorkbenchLayout();
  // 窄窗口抽屉只在当前视口内开合，不污染桌面侧栏的持久化展开状态。
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarVisible = isMobile ? mobileSidebarOpen : layout.sidebarVisible;
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);
  const [sendKey, setSendKeyState] = useState<SendKey>(loadSendKey);
  const [sessionDefaults, setSessionDefaultsState] = useState<SessionDefaults>(loadSessionDefaults);
  const setSendKey = (value: SendKey): void => { setSendKeyState(value); saveSendKey(value); };
  const setSessionDefaults = (value: SessionDefaults): void => { setSessionDefaultsState(value); saveSessionDefaults(value); };
  // 草稿按会话保留，切换会话不丢
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 草稿附件也按会话隔离；异步发送完成只能清理自己的源会话。
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, PendingImage[]>>({});
  // WebSocket token delta 在 React 之外缓冲、按动画帧合批提交（见 use-stream-buffers）
  const { stream, thinkingStream, queueDelta: queueStreamDelta, flush: flushStreamBuffers, finish: finishBufferedStreams, clear: clearStream, discard: discardStream } = useStreamBuffers();
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [agentStates, setAgentStates] = useState<Record<string, string>>({});
  // 上下文窗口水位（context.watermark）：按会话保留最近一次，切换会话展示该会话最后已知水位
  const [watermarks, setWatermarks] = useState<Record<string, ContextWatermark>>({});
  // 最近一轮 token 用量（context.usage）：按会话保留，驱动缓存命中率展示
  const [usages, setUsages] = useState<Record<string, ContextUsage>>({});
  // agent 完成检测（通知中心）：记录每个会话上一状态，busy→idle 视为一轮任务完成
  const lastStatesRef = useRef<Record<string, string>>({});
  // agent.error 除了短暂 toast，也保留在当前会话的轨道中；下一次真正开始运行时再清除。
  const [runFailures, setRunFailures] = useState<Record<string, AgentErrorPayload>>({});
  // 主区子代理标签（0.7.x）：按会话键控，subagent.started 自动创建（不抢焦点）
  const { tabsBySession: subagentTabs, selectedBySession: selectedSubagentTabs, openFromStarted: openSubagentTabFromStarted, openTab: focusSubagentTab, selectTab: selectSubagentTab, closeTab: closeSubagentTab, removeSession: removeSubagentTabsSession } = useSubagentTabs();
  // 主区终端标签：每会话一个，开/关与选中态按会话键控；选中与子代理标签互斥
  const { openBySession: terminalTabsOpen, selectedBySession: terminalTabsSelected, openTerminal, setTerminalSelected, closeTerminal, removeSession: removeTerminalTabsSession } = useTerminalTabs();
  // 子代理运行状态：sessionId → taskId → run；终态保留（子代理面板需要会话级历史），按会话封顶
  const { liveSubagents, applyEvent: applySubagentEvent, removeSession: removeSubagentSession } = useLiveSubagents({ dropOnToolEnd: false, onStarted: openSubagentTabFromStarted });
  // Problems 视图角标：diagnostics.updated 到达时记录未查看失败数，打开 Problems 视图清除
  const [problemsBadges, setProblemsBadges] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<Notice>();
  // 失败类提示用 error（红色、role=alert），成功/进度类用 info；同时汇入通知中心
  const notify = useCallback((text: string, kind: Notice["kind"] = "info"): void => {
    setNotice({ kind, text });
    setNotifications((previous) => pushNotification(previous, { kind, text }));
  }, []);
  // 后台事件进通知流（可带跳转目标），不弹 toast 打扰
  const pushEventNotification = useCallback((text: string, kind: AppNotification["kind"], target?: AppNotification["target"]): void => {
    setNotifications((previous) => pushNotification(previous, { kind, text, ...(target ? { target } : {}) }));
  }, []);
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions });
  const detail = useQuery({ queryKey: queryKeys.detail(currentId ?? ""), queryFn: () => api.session(currentId!, 100), enabled: Boolean(currentId) });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const queue = useQuery({ queryKey: ["queue", currentId], queryFn: () => api.queue(currentId!), enabled: Boolean(currentId) });
  const interactions = useQuery({ queryKey: ["interactions", currentId], queryFn: () => api.interactions(currentId!), enabled: Boolean(currentId) });
  const contextView = useQuery({ queryKey: ["context", currentId], queryFn: () => api.context(currentId!), enabled: Boolean(currentId) });
  const skills = useQuery({ queryKey: queryKeys.skills(currentId ?? ""), queryFn: () => api.skills(currentId!), enabled: Boolean(currentId) });
  const todos = useQuery({ queryKey: ["todos", currentId], queryFn: () => api.todos(currentId!), enabled: Boolean(currentId) });
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  const contentLens = useMemo(() => extensions.data?.find((extension) => extension.id === "content-lens" && extension.enabled), [extensions.data]);
  // 服务设置与更新检查：用于启动后一次性提示新版本（与 SettingsDialog 共用缓存键；retry:false 避免 501 重试）
  const serverSettings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 5 * 60_000 });
  const updateCheck = useQuery({ queryKey: ["update-check"], queryFn: api.updateCheck, staleTime: 5 * 60_000, retry: false });
  // 符号索引状态（Phase 2）：server 未启用索引时 501，保持隐藏（retry:false）
  const indexStatus = useQuery({ queryKey: ["index-status", currentId], queryFn: () => api.indexStatus(currentId!), enabled: Boolean(currentId), retry: false });
  // 待确认权限以服务端为准（刷新后可恢复），WS 事件只作即时补充
  const serverPermissions = useQuery({ queryKey: ["permissions", currentId], queryFn: () => api.pendingPermissions(currentId!), enabled: Boolean(currentId) });
  const { data: currentRun, applyEvent: applyRunEvent } = useAgentRun(currentId);
  // 实时活动（agent.state + tool.start/end）：对话区底部吸底活动条的数据源
  const { activityFor, applyEvent: applyActivityEvent } = useLiveActivity();

  useEffect(() => {
    if (!currentId && sessions.data?.[0]) setCurrentId(sessions.data[0].id);
  }, [currentId, sessions.data]);

  // 新版本提示（0.7.x）：更新检查启用且发现更新版本时通知中心提示一次（按版本去重，点击跳转 设置 → 服务信息）
  const notifiedUpdateVersionsRef = useRef(new Set<string>());
  useEffect(() => {
    const enabled = serverSettings.data?.groups.some((group) =>
      group.fields.some((field) => field.key === "updateCheckEnabled" && field.value === true)) === true;
    const snapshot = updateCheck.data?.snapshot;
    if (!enabled || !snapshot?.isNewer) return;
    if (notifiedUpdateVersionsRef.current.has(snapshot.latestVersion)) return;
    notifiedUpdateVersionsRef.current.add(snapshot.latestVersion);
    pushEventNotification(
      t(`发现新版本 v${snapshot.latestVersion}，前往 设置 → 服务信息 更新`, `New version v${snapshot.latestVersion} available — go to Settings → Server info to update`),
      "info",
      { settingsTab: "info" },
    );
  }, [serverSettings.data, updateCheck.data, pushEventNotification, t]);

  const handleSessionEvent = useCallback((event: AppEvent): void => {
        applyRunEvent(event);
        applyActivityEvent(event);
        if (event.type === "resync.required") {
          // 事件流为全局订阅：按事件所属会话刷新，缺省回退当前会话。
          const targetId = event.sessionId ?? currentId;
          // 0.5.0 Phase 2：resync 时清空分页加载的更早消息（可能已过期）
          if (targetId === currentId) {
            setOlderMessages([]);
            setHasMoreOlder(false);
          }
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(targetId ?? "") });
          queryClient.invalidateQueries({ queryKey: ["context", targetId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", targetId] });
          queryClient.invalidateQueries({ queryKey: ["todos", targetId] });
          queryClient.invalidateQueries({ queryKey: ["tasks", targetId] });
          queryClient.invalidateQueries({ queryKey: ["diagnostics", targetId] });
          queryClient.invalidateQueries({ queryKey: ["scm-status", targetId] });
          queryClient.invalidateQueries({ queryKey: ["scm-worktrees", targetId] });
          if (targetId) queryClient.invalidateQueries({ queryKey: ["run", targetId] });
          return;
        }
        // agent.state 跨会话跟踪：驱动侧栏运行标记与头部状态徽章
        if (event.type === "agent.state" && event.sessionId) {
          const state = (event.payload as { state?: string }).state;
          if (state) {
            const previousState = lastStatesRef.current[event.sessionId];
            lastStatesRef.current[event.sessionId] = state;
            if (state === "idle" && previousState && isBusyState(previousState)) {
              pushEventNotification(
                t(`会话任务已完成（${sessions.data?.find((session) => session.id === event.sessionId)?.title ?? event.sessionId}）`, `Run finished (${sessions.data?.find((session) => session.id === event.sessionId)?.title ?? event.sessionId})`),
                "info",
                { sessionId: event.sessionId, view: "sessions" },
              );
            }
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
        // 上下文窗口水位跨会话跟踪：驱动 JobHeader 与上下文面板的占用 meter
        if (event.type === "context.watermark" && event.sessionId) {
          setWatermarks((previous) => ({ ...previous, [event.sessionId!]: event.payload as ContextWatermark }));
        }
        if (event.type === "context.usage" && event.sessionId) {
          setUsages((previous) => ({ ...previous, [event.sessionId!]: event.payload as ContextUsage }));
        }
        // 子代理生命周期跨会话跟踪：驱动消息轨道实时卡片与子代理面板（终态保留）
        applySubagentEvent(event);
        if (event.type === "run.accepted" && event.sessionId) {
          setRunFailures((previous) => {
            if (!(event.sessionId! in previous)) return previous;
            const { [event.sessionId!]: _cleared, ...remaining } = previous;
            return remaining;
          });
        }
        // 诊断更新（Phase 3）：刷新 Problems 视图数据并更新角标；不弹窗不打断
        if (event.type === "diagnostics.updated" && event.sessionId) {
          queryClient.invalidateQueries({ queryKey: ["diagnostics", event.sessionId] });
          const failed = (event.payload as { summary?: { failed?: number } }).summary?.failed ?? 0;
          setProblemsBadges((previous) => applyDiagnosticsBadgeUpdate(previous, event.sessionId!, failed));
          if (failed > 0) {
            pushEventNotification(t(`诊断更新：${failed} 项失败`, `Diagnostics updated: ${failed} failure(s)`), "error", { sessionId: event.sessionId, view: "problems" });
          }
        }
        // SCM 更新（Phase 4）：刷新源代码管理面板数据；不弹窗不打断
        if (event.type === "scm.updated" && event.sessionId) {
          queryClient.invalidateQueries({ queryKey: ["scm-status", event.sessionId] });
          queryClient.invalidateQueries({ queryKey: ["scm-worktrees", event.sessionId] });
          queryClient.invalidateQueries({ queryKey: ["scm-diff", event.sessionId] });
          pushEventNotification(t("源代码管理状态已更新", "Source control state updated"), "info", { sessionId: event.sessionId, view: "scm" });
        }
        if (event.type === "agent.error" && event.sessionId) {
          const payload = event.payload as Partial<AgentErrorPayload>;
          setRunFailures((previous) => ({
            ...previous,
            [event.sessionId!]: {
              message: payload.message ?? t("未知错误", "unknown error"),
              ...(payload.kind ? { kind: payload.kind } : {}),
              retryable: payload.retryable === true,
            },
          }));
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
        // 会话显示属性变更（重命名/置顶，可能来自其他客户端）：任何会话都刷新列表；详情仅当前会话
        if (event.type === "session.updated" && event.sessionId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
          if (event.sessionId === currentId) queryClient.invalidateQueries({ queryKey: queryKeys.detail(event.sessionId) });
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
          // toast 只给一句话摘要（按 kind 分类），原始错误细节留在轨道上的错误卡中
          notify(agentErrorToastText(event.payload as Partial<AgentErrorPayload>, t), "error");
        }
        if (event.type === "todos.updated") {
          queryClient.setQueryData<TodoItem[]>(["todos", event.sessionId], (event.payload as { items?: TodoItem[] }).items ?? []);
        }
        // 索引状态事件（index.status）：payload 即完整状态对象，直接写缓存驱动状态栏
        if (event.type === "index.status") {
          queryClient.setQueryData<WorkspaceIndexStatus>(["index-status", event.sessionId], event.payload as WorkspaceIndexStatus);
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
        const refreshDetail = ["agent.state", "tool.end", "agent.error", "session.config_updated", "subagent.finished"].includes(event.type);
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
            void detailRefresh.finally(() => clearStream(event.sessionId!));
          }
        }
  }, [applyRunEvent, applyActivityEvent, applySubagentEvent, clearStream, currentId, flushStreamBuffers, notify, pushEventNotification, queryClient, queueStreamDelta, sessions.data, t]);
  // 全局订阅：服务端在未传 sessionId 时全量推送，handler 按 event.sessionId 分发。
  const { reconnecting } = useSessionEventStream({ onEvent: handleSessionEvent, onDisconnect: finishBufferedStreams });

  const current = detail.data;
  // 0.5.0 Phase 2：合并分页加载的更早消息，形成完整显示会话
  const displaySession = useMemo<SessionDetail | undefined>(() => {
    if (!current) return current;
    if (olderMessages.length === 0) return current;
    return { ...current, messages: [...olderMessages, ...current.messages] };
  }, [current, olderMessages]);
  // 子代理面板数据：实时运行（终态保留）+ 从已加载消息推导的历史运行，实时条目优先。
  // 推导只依赖会话消息（刷新/翻页才重算），不与实时进度 tick 耦合；合并层随进度 tick 更新。
  const derivedSubagentRuns = useMemo(
    () => deriveSubagentRunsFromMessages(displaySession?.messages ?? []),
    [displaySession],
  );
  const subagentRuns = useMemo(
    () => mergeSubagentRuns(currentId ? liveSubagents[currentId] ?? {} : {}, derivedSubagentRuns),
    [currentId, liveSubagents, derivedSubagentRuns],
  );
  // 当前会话选中的子代理标签（undefined = 「主对话」或终端）；标签列表按会话隔离，切换会话自动回主对话
  const currentSubagentTabs = currentId ? subagentTabs[currentId] ?? [] : [];
  const selectedSubagentTab = currentId ? selectedSubagentTabs[currentId] : undefined;
  // 当前会话终端标签：open 渲染标签与面板（保持挂载），selected 决定内容互换
  const terminalOpen = currentId ? terminalTabsOpen[currentId] === true : false;
  const terminalSelected = terminalOpen && currentId ? terminalTabsSelected[currentId] === true : false;
  // 子代理面板「在标签中打开」：从合并运行记录取标签字段，创建并聚焦（关闭不影响运行本身）
  const openSubagentTab = useCallback((toolCallId: string): void => {
    if (!currentId) return;
    const run = Object.values(subagentRuns).find((entry) => entry.toolCallId === toolCallId);
    if (!run) return;
    focusSubagentTab(currentId, {
      toolCallId,
      prompt: run.prompt,
      ...(run.agent ? { agent: run.agent } : {}),
      ...(run.swarm ? { swarmTotal: run.swarm.total } : {}),
    });
    // 选中互斥：聚焦子代理标签时取消终端选中
    setTerminalSelected(currentId, false);
  }, [currentId, subagentRuns, focusSubagentTab, setTerminalSelected]);
  // 活动栏终端入口：打开并选中当前会话终端标签（同时清除子代理选中，保证互斥）
  const openTerminalTab = useCallback((): void => {
    if (!currentId) return;
    openTerminal(currentId);
    selectSubagentTab(currentId, undefined);
  }, [currentId, openTerminal, selectSubagentTab]);
  const currentState = currentRun?.state ?? (currentId ? agentStates[currentId] : undefined);
  const running = Boolean(stream[currentId ?? ""]) || isBusyState(currentState);
  // 对话区底部实时活动条：WS 工具事件优先，状态/起始时间回退到 run 快照（刷新页面后首个事件前可用）
  const liveActivity = useMemo<LiveActivityInfo | undefined>(() => {
    if (!currentId) return undefined;
    const info = activityFor(currentId);
    const state = info?.state ?? currentState;
    if (!state || INACTIVE_STATES.has(state)) return undefined;
    const since = info?.since ?? (currentRun?.since ? Date.parse(currentRun.since) : undefined);
    return {
      state,
      ...(since !== undefined && !Number.isNaN(since) ? { since } : {}),
      ...(info?.currentTool ? { currentTool: info.currentTool } : {}),
      toolCount: info?.toolCount ?? 0,
    };
  }, [activityFor, currentId, currentState, currentRun?.since]);
  // Composer 输入历史：本会话已发送的用户消息（最新在前），↑/↓ 回查
  const inputHistory = useMemo(() => deriveInputHistory(displaySession?.messages ?? []), [displaySession]);
  const runningIds = useMemo(
    () => new Set(Object.entries(agentStates).filter(([, state]) => isBusyState(state)).map(([id]) => id)),
    [agentStates],
  );
  // 切换会话后丢弃上一会话的 WS 即时权限卡，改由服务端列表播种
  useEffect(() => setPendingPermissions([]), [currentId]);
  // 新会话永远回到纯对话：切换会话即关闭编辑器/diff 分栏（布局回归约束）
  useEffect(() => {
    setEditorPane(undefined);
    setDiffPane(undefined);
    // 0.5.0 Phase 2：清空分页加载的更早消息
    setOlderMessages([]);
    setHasMoreOlder(false);
  }, [currentId]);
  // 0.5.0 Phase 2：初始页加载后同步 hasMoreMessages
  useEffect(() => {
    setHasMoreOlder(current?.hasMoreMessages ?? false);
  }, [current?.hasMoreMessages]);
  // 0.5.0 Phase 2：加载更早消息——基于当前最旧消息 ID 向前翻页
  const loadMoreMessages = useCallback(async (): Promise<void> => {
    if (!current || loadingMore) return;
    const oldestId = olderMessages.length > 0 ? olderMessages[0]!.id : current.messages[0]?.id;
    if (!oldestId) return;
    setLoadingMore(true);
    try {
      const page = await api.messagesPage(current.id, oldestId, 100);
      setOlderMessages((prev) => [...page.messages, ...prev]);
      setHasMoreOlder(page.hasMore);
    } catch {
      // 网络错误静默处理——用户可重试
    } finally {
      setLoadingMore(false);
    }
  }, [current, olderMessages, loadingMore]);
  // 编辑器命令动作面：mod+s 保存 / mod+\ 焦点切换（EditorPane 挂载时注册）
  const editorActionsRef = useRef<{ save?(): void; focus?(): void }>({});
  // diff 视图命令动作面：接受/拒绝当前 hunk（DiffPane 挂载时注册）
  const diffActionsRef = useRef<{ accept?(): void; reject?(): void; focus?(): void }>({});
  // 打开编辑器分栏；移动端不提供编辑器，降级为只读代码视图浮层（§6.8 语义平移）
  const openEditor = useCallback((path: string, position?: { line?: number; column?: number }): void => {
    if (isMobile) {
      setCodeOverlayPath(path);
      return;
    }
    setCodeOverlayPath(undefined);
    setQuickOpenOpen(false);
    setDiffPane(undefined);
    setEditorPane({ path, ...(position?.line !== undefined ? { line: position.line } : {}), ...(position?.column !== undefined ? { column: position.column } : {}) });
  }, [isMobile]);
  // 打开统一 diff 视图（0.5.0 Phase 1b）：桌面进分栏，移动端降级只读摘要浮层
  const openDiff = useCallback((spec: DiffSpec): void => {
    setCodeOverlayPath(undefined);
    setQuickOpenOpen(false);
    setEditorPane(undefined);
    setDiffPane(spec);
  }, []);
  // diff/编辑器操作完成后焦点回 Composer（对话为主约束）
  const focusComposer = useCallback((): void => {
    document.getElementById("composer-input")?.focus();
  }, []);
  const closeEditor = useCallback((): void => {
    setEditorPane(undefined);
    focusComposer();
  }, [focusComposer]);
  const closeDiff = useCallback((): void => {
    setDiffPane(undefined);
    focusComposer();
  }, [focusComposer]);
  // 编辑重发状态：进入时暂存当前草稿并把目标 user 消息文本灌入 Composer；取消/Esc/切换会话恢复暂存
  const [editingMessage, setEditingMessage] = useState<{ sessionId: string; messageId: string; hadAttachments: boolean } | undefined>();
  const editingRef = useRef(editingMessage);
  useEffect(() => { editingRef.current = editingMessage; }, [editingMessage]);
  const editStashRef = useRef("");
  const cancelEdit = useCallback((restoreDraft = true): void => {
    const target = editingRef.current;
    if (!target) return;
    if (restoreDraft) setDrafts((previous) => ({ ...previous, [target.sessionId]: editStashRef.current }));
    setEditingMessage(undefined);
  }, []);
  const startEditMessage = useCallback((message: ChatMessage): void => {
    if (!currentId || running) return;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (!text) return;
    setEditingMessage({ sessionId: currentId, messageId: message.id, hadAttachments: message.content.some((block) => block.type !== "text") });
    setDrafts((previous) => {
      // updater 内暂存旧草稿：StrictMode 双调拿到同一 previous，结果一致
      editStashRef.current = previous[currentId] ?? "";
      return { ...previous, [currentId]: text };
    });
    focusComposer();
  }, [currentId, running, focusComposer]);
  // 会话切换：退出编辑态并把暂存草稿还给原会话
  useEffect(() => {
    const target = editingRef.current;
    if (target && target.sessionId !== currentId) cancelEdit();
  }, [currentId, cancelEdit]);
  // 重新生成：检出到该 user 消息的父节点并重跑（服务端 202 起新 run）
  const regenerateMessage = useCallback((message: ChatMessage): void => {
    if (!currentId || running) return;
    api.retryMessage(currentId, message.id, {})
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId) });
        void queryClient.invalidateQueries({ queryKey: ["timeline", currentId] });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("重新生成失败", "Regeneration failed"), "error"));
  }, [currentId, running, queryClient, notify, t]);
  // 分叉：复制到该节点为止的对话为新会话并切换过去（运行中允许）
  const forkConversation = useCallback((messageId?: string): void => {
    if (!currentId) return;
    api.forkSession(currentId, messageId ? { messageId } : {})
      .then(({ sessionId: newId }) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        setCurrentId(newId);
        notify(t("已分叉到新会话", "Forked into a new session"));
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("分叉失败", "Fork failed"), "error"));
  }, [currentId, queryClient, notify, t]);
  const forkMessage = useCallback((message: ChatMessage): void => forkConversation(message.id), [forkConversation]);
  // 打开 Problems 侧栏视图即视为已查看，清除角标（原底部面板语义平移）
  useEffect(() => {
    if (layout.sidebarView === "problems" && sidebarVisible && currentId) {
      setProblemsBadges((previous) => clearDiagnosticsBadge(previous, currentId));
    }
  }, [layout.sidebarView, sidebarVisible, currentId]);
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

  // 草稿持久化（localStorage `owc-draft-<id>`）：内存 drafts 的镜像，发送后清空条目。
  // 用 ref 记录上次写入值，每次只写变化的键（含删除），避免逐键全量重写 localStorage。
  const draftMirrorRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const previous = draftMirrorRef.current;
    for (const [sessionId, value] of Object.entries(drafts)) {
      if (previous[sessionId] !== value) saveDraft(sessionId, value);
    }
    for (const sessionId of Object.keys(previous)) {
      if (!(sessionId in drafts)) saveDraft(sessionId, "");
    }
    draftMirrorRef.current = { ...drafts };
  }, [drafts]);
  // 选中会话时：内存无草稿则从 localStorage 恢复（刷新/重开不丢未发送内容）
  useEffect(() => {
    if (!currentId) return;
    setDrafts((previous) => {
      if (currentId in previous) return previous;
      const saved = loadDraft(currentId);
      return saved === undefined ? previous : { ...previous, [currentId]: saved };
    });
  }, [currentId]);
  // 会话列表加载后修剪已删除会话残留的草稿键
  useEffect(() => {
    if (sessions.data) pruneDrafts(new Set(sessions.data.map((session) => session.id)));
  }, [sessions.data]);

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

  // Composer 发送与 session.send 命令共用同一提交逻辑（键盘全流程可达）
  const submitDraft = useCallback((behavior?: "start" | "steer" | "follow_up"): void => {
    if (!currentId) return;
    const text = (drafts[currentId] ?? "").trim();
    if (!text) return;
    // 编辑重发：走 retry（检出到父节点 + 附带编辑后的 user 消息重跑），不走普通消息 POST
    if (editingMessage && editingMessage.sessionId === currentId) {
      const target = editingMessage;
      cancelEdit(false);
      api.retryMessage(currentId, target.messageId, { editedContent: text })
        .then(() => {
          setDrafts((previous) => ({ ...previous, [currentId]: "" }));
          setAttachmentsBySession((previous) => ({ ...previous, [currentId]: [] }));
          void queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId) });
          void queryClient.invalidateQueries({ queryKey: ["timeline", currentId] });
        })
        .catch((error: unknown) => notify(error instanceof Error ? error.message : t("重发失败", "Resend failed"), "error"));
      return;
    }
    // /help 是纯客户端内置命令：打开快捷键速查（同 Shift+?），不进 agent run
    if (text === "/help") {
      setDrafts((previous) => ({ ...previous, [currentId]: "" }));
      setShortcutsOpen(true);
      return;
    }
    send.mutate({
      sessionId: currentId,
      text,
      images: attachmentsBySession[currentId] ?? [],
      pathAttachments: toAttachments(extractAttachmentPaths(text)),
      behavior: behavior ?? (running ? "steer" : "start"),
    });
  }, [currentId, drafts, attachmentsBySession, running, send, editingMessage, cancelEdit, queryClient, notify, t]);

  // 错误卡「重试」：重发本会话最近一条用户消息（限流/过载等 retryable 失败后的快捷恢复）
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
      // 跳过 `!` 前缀的 shell 快捷消息：重试应重发真正的 agent 输入，而不是 shell 命令
      if (text && !text.startsWith("!")) return text;
    }
    return undefined;
  }, [displaySession]);
  const retryRun = useCallback((): void => {
    if (!currentId || !lastUserMessageText || running) return;
    send.mutate({
      sessionId: currentId,
      text: lastUserMessageText,
      images: [],
      pathAttachments: toAttachments(extractAttachmentPaths(lastUserMessageText)),
      behavior: "start",
    });
  }, [currentId, lastUserMessageText, running, send]);

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

  // 删除确认对话框（替代原生 window.confirm）：点删除只打开确认，确认后才真正 DELETE
  const [deleteTarget, setDeleteTarget] = useState<string | undefined>();
  const removeSession = (id: string): void => setDeleteTarget(id);
  const confirmDelete = (): void => {
    const id = deleteTarget;
    setDeleteTarget(undefined);
    if (!id) return;
    api.deleteSession(id)
      .then(() => {
        if (currentId === id) setCurrentId(sessions.data?.find((session) => session.id !== id)?.id);
        // 同步清理按会话键控的内存状态，避免已删会话的条目残留
        const removeKey = <T,>(previous: Record<string, T>): Record<string, T> => {
          if (!(id in previous)) return previous;
          const { [id]: _removed, ...remaining } = previous;
          return remaining;
        };
        setDrafts(removeKey);
        setAttachmentsBySession(removeKey);
        setAgentStates(removeKey);
        setWatermarks(removeKey);
        setUsages(removeKey);
        setRunFailures(removeKey);
        removeSubagentSession(id);
        removeSubagentTabsSession(id);
        removeTerminalTabsSession(id);
        setProblemsBadges(removeKey);
        delete lastStatesRef.current[id];
        discardStream(id);
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : t("删除会话失败", "Could not delete session"), "error"));
  };

  // 会话显示属性（重命名/置顶）：PATCH 后刷新列表；当前会话同步刷新详情（标题展示在作业头）
  const patchSession = useMutation({
    mutationFn: (input: { id: string; body: { title?: string; pinned?: boolean } }) => api.patchSession(input.id, input.body),
    onSuccess: (_updated, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      if (input.id === currentId) void queryClient.invalidateQueries({ queryKey: queryKeys.detail(input.id) });
    },
    onError: (error) => notify(error instanceof Error ? error.message : t("更新会话失败", "Could not update session"), "error"),
  });

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
  // 上下文窗口占用：WS 实时水位优先，否则由 REST stats + 模型档案播种（刷新后首个 watermark 前可用）
  const windowInfo = useMemo(
    () => deriveWindowInfo(currentId ? watermarks[currentId] : undefined, contextView.data?.stats, model),
    [watermarks, currentId, contextView.data?.stats, model],
  );
  // 当前会话最近一轮 token 用量（context.usage），驱动缓存命中率 pill/行
  const latestUsage = currentId ? usages[currentId] : undefined;

  const resetLayout = (): void => {
    for (const key of LAYOUT_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
    window.location.reload();
  };

  // ===== 命令体系（Phase 5a）：when 上下文 + 动作面 + 注册 =====
  const whenContext: WhenContext = useMemo(() => ({
    sessionActive: Boolean(currentId),
    running,
    draftNonEmpty: Boolean(draft.trim()),
    multipleSessions: (sessions.data?.length ?? 0) > 1,
    // 浮层打开状态（含通知中心）：供命令 when 条件使用（如 "!dialogOpen"）
    dialogOpen: dialogOpen || settingsOpen || paletteOpen || quickOpenOpen || shortcutsOpen || notificationsOpen || Boolean(codeOverlayPath),
    // 编辑器分栏开合（0.5.0）：保存/焦点切换命令的 when 条件
    editorOpen: Boolean(editorPane) && !isMobile,
    // diff 视图开合（0.5.0 Phase 1b）：hunk 接受/拒绝命令的 when 条件
    diffOpen: Boolean(diffPane) && !isMobile,
    // 权限卡待决：Esc 中断等全局键位不抢占权限响应焦点
    permissionPending: mergedPermissions.length > 0,
  }), [currentId, running, draft, sessions.data, dialogOpen, settingsOpen, paletteOpen, quickOpenOpen, shortcutsOpen, notificationsOpen, codeOverlayPath, editorPane, diffPane, isMobile, mergedPermissions]);

  const stepSession = useCallback((delta: number): void => {
    const list = sessions.data ?? [];
    if (list.length < 2) return;
    const index = list.findIndex((session) => session.id === currentId);
    const next = list[(Math.max(index, 0) + delta + list.length) % list.length];
    if (next) setCurrentId(next.id);
  }, [sessions.data, currentId]);

  const showWorkbenchView = useCallback((view: SidebarView): void => {
    if (!isMobile) {
      layout.showView(view);
      return;
    }
    if (mobileSidebarOpen && layout.sidebarView === view) {
      setMobileSidebarOpen(false);
      return;
    }
    layout.selectView(view);
    setMobileSidebarOpen(true);
  }, [isMobile, layout.selectView, layout.showView, layout.sidebarView, mobileSidebarOpen]);

  const toggleWorkbenchSidebar = useCallback((): void => {
    if (isMobile) setMobileSidebarOpen((open) => !open);
    else layout.toggleSidebar();
  }, [isMobile, layout.toggleSidebar]);

  // 命令动作面存 ref：注册表只挂一次，handler 每次取最新动作（闭包不捕获过期状态）
  const actionsRef = useRef<CommandActions>(null as unknown as CommandActions);
  actionsRef.current = {
    showCommands: () => setPaletteOpen(true),
    quickOpen: () => setQuickOpenOpen(true),
    toggleSidebar: toggleWorkbenchSidebar,
    toggleBottomPanel: layout.toggleBottomPanel,
    showView: showWorkbenchView,
    openSettings: () => openSettings(),
    newSession: () => setDialogOpen(true),
    importSession: () => importInput.current?.click(),
    deleteCurrentSession: () => { if (currentId) removeSession(currentId); },
    sendDraft: () => submitDraft(),
    abortRun: () => {
      if (!currentId) return;
      api.abort(currentId).catch((error: unknown) => notify(error instanceof Error ? error.message : t("无法中断", "Could not stop the job"), "error"));
    },
    toggleTheme,
    focusComposer: () => document.getElementById("composer-input")?.focus(),
    nextSession: () => stepSession(1),
    previousSession: () => stepSession(-1),
    showKeyboardShortcuts: () => setShortcutsOpen(true),
    cycleZone: () => window.dispatchEvent(new CustomEvent(CYCLE_ZONE_EVENT)),
    showNotifications: () => setNotificationsOpen(true),
    saveEditorFile: () => editorActionsRef.current.save?.(),
    toggleEditorSplit: () => {
      const inEditor = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".editor-pane"));
      if (inEditor) document.getElementById("composer-input")?.focus();
      else editorActionsRef.current.focus?.();
    },
    // 统一 diff 视图（0.5.0 Phase 1b）：接受/拒绝当前（首个待处理）hunk，写回走权限链
    diffAcceptHunk: () => diffActionsRef.current.accept?.(),
    diffRejectHunk: () => diffActionsRef.current.reject?.(),
    // 会话内搜索：状态在 ExecutionTrack，经 window 事件桥接（同 cycleZone 模式）
    findInConversation: () => window.dispatchEvent(new CustomEvent(CONVERSATION_SEARCH_EVENT)),
  };
  useEffect(() => registerBuiltinCommands(() => actionsRef.current), []);
  useGlobalKeybindings(whenContext);

  // 通知中心开合（在 actionsRef 之前声明，命令动作面引用）
  const openNotifications = useCallback((): void => {
    setNotificationsOpen(true);
  }, []);

  // 关闭时全部标记已读（角标清零；列表内未读高亮在打开期间可见）
  const closeNotifications = useCallback((): void => {
    setNotificationsOpen(false);
    setNotifications((previous) => markAllRead(previous));
  }, []);

  const activateNotification = useCallback((item: AppNotification): void => {
    setNotifications((previous) => markRead(previous, item.id));
    setNotificationsOpen(false);
    if (item.target?.sessionId) setCurrentId(item.target.sessionId);
    if (item.target?.view) showWorkbenchView(item.target.view);
    // 设置深链（如新版本提示 → 服务信息页签）
    if (item.target?.settingsTab) openSettings(item.target.settingsTab);
  }, [showWorkbenchView, openSettings]);

  // 移动端抽屉：选中会话后收起侧栏（桌面端行为不变）
  const selectSession = useCallback((id: string): void => {
    setCurrentId(id);
    if (isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  const sidebar = sidebarVisible ? (
    layout.sidebarView === "sessions" ? (
      <SessionRail
        sessions={sessions.data}
        currentId={currentId}
        runningIds={runningIds}
        theme={theme}
        collapsed={false}
        width={layout.sidebarWidth}
        onSelect={selectSession}
        onCreate={() => setDialogOpen(true)}
        onDelete={removeSession}
        onRename={(id, title) => patchSession.mutate({ id, body: { title } })}
        onTogglePin={(id, pinned) => patchSession.mutate({ id, body: { pinned } })}
        onImport={importSession}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => openSettings()}
        onResize={layout.setSidebarWidth}
      />
    ) : (
      <SidebarPanel
        view={layout.sidebarView}
        width={layout.sidebarWidth}
        onResize={layout.setSidebarWidth}
        sessionId={currentId}
        session={current}
        running={running}
        onNotice={notify}
        onOpenInEditor={isMobile ? undefined : (file, line, column) => openEditor(file, { ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) })}
        onOpenDiff={openDiff}
      />
    )
  ) : undefined;

  return (
    <>
      <WorkbenchShell
        sidebarWidth={sidebarVisible ? layout.sidebarWidth : undefined}
        activityBar={
          <ActivityBar
            activeView={layout.sidebarView}
            sidebarVisible={sidebarVisible}
            problemsBadge={currentId ? problemsBadges[currentId] ?? 0 : 0}
            notificationsBadge={unreadCount(notifications)}
            onShowView={showWorkbenchView}
            onToggleSidebar={layout.toggleSidebar}
            onShowHelp={() => setShortcutsOpen(true)}
            onShowNotifications={openNotifications}
            onOpenTerminal={openTerminalTab}
            terminalDisabled={!current}
            onOpenSettings={() => openSettings()}
          />
        }
        sidebar={sidebar}
        main={
          // 编辑器分栏是对话的辅助视图：同屏不超过主区一半（CSS 约束），关闭即回纯对话
          <div className="wb-main-split">
            <section className="workbench">
            {current ? (
              <>
                <JobHeader
                  session={current}
                  agentState={currentState}
                  costSummary={costSummary}
                  windowUsage={windowInfo}
                  {...(latestUsage ? { latestUsage } : {})}
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
                {!isMobile && (
                  <SubagentTabStrip
                    tabs={currentSubagentTabs}
                    runs={subagentRuns}
                    selected={selectedSubagentTab}
                    {...(terminalOpen ? { terminal: { selected: terminalSelected } } : {})}
                    onSelect={(toolCallId) => {
                      selectSubagentTab(current.id, toolCallId);
                      // 选中互斥：选主对话/子代理标签时取消终端选中
                      setTerminalSelected(current.id, false);
                    }}
                    onClose={(toolCallId) => closeSubagentTab(current.id, toolCallId)}
                    onSelectTerminal={() => {
                      selectSubagentTab(current.id, undefined);
                      setTerminalSelected(current.id, true);
                    }}
                    onCloseTerminal={() => closeTerminal(current.id)}
                  />
                )}
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
                {/* 主对话/终端/子代理标签内容互换：ExecutionTrack 保持挂载（hidden 隐藏），滚动与展开状态不丢 */}
                <div className="main-tab-panel" role="tabpanel" aria-label={t("主对话", "Main")} hidden={selectedSubagentTab !== undefined || terminalSelected}>
                <ExecutionTrack
                  session={displaySession ?? current}
                  trackVisible={selectedSubagentTab === undefined && !terminalSelected}
                  contentLens={contentLens}
                  onNotice={notify}
                  liveSubagents={liveSubagents[current.id] ?? {}}
                  {...(contextView.data?.ledger.cleared ? { cleared: contextView.data.ledger.cleared } : {})}
                  streamText={stream[current.id] ?? ""}
                  thinkingText={thinkingStream[current.id] ?? ""}
                  runError={runFailures[current.id]}
                  permissions={mergedPermissions}
                  onSendToAgent={sendShellToAgent}
                  onOpenSettings={openSettings}
                  {...(lastUserMessageText && !running ? { onRetryRun: retryRun } : {})}
                  retryPending={send.isPending}
                  onPermissionDone={(requestId) => {
                    setPendingPermissions((prev) => prev.filter((item) => item.requestId !== requestId));
                    queryClient.invalidateQueries({ queryKey: ["permissions", current.id] });
                  }}
                  onPermissionError={(message) => notify(message, "error")}
                  onOpenDiff={openDiff}
                  running={running}
                  onEditMessage={startEditMessage}
                  onRegenerate={regenerateMessage}
                  onFork={forkMessage}
                  hasMoreMessages={hasMoreOlder}
                  onLoadMore={loadMoreMessages}
                  loadingMore={loadingMore}
                  liveActivity={liveActivity}
                />
                </div>
                {terminalOpen && (
                  <div className="main-tab-panel" role="tabpanel" aria-label={t("终端", "Terminal")} hidden={!terminalSelected}>
                    <TerminalView session={displaySession ?? current} onNotice={notify} />
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
                  <InteractionCard key={item.id} item={item} onRespond={(answer) => api.respondInteraction(current.id, item.id, answer)
                    .then(() => interactions.refetch())
                    .catch((error: unknown) => notify(error instanceof Error ? error.message : t("提交回答失败", "Could not submit answer"), "error"))} />
                ))}
                <Composer
                  current={current}
                  model={model}
                  models={models.data ?? []}
                  providers={providers.data ?? []}
                  history={inputHistory}
                  pdfToImageExtension={extensions.data?.find((extension) => extension.id === "pdf-to-image")}
                  pdfToImageStatus={extensions.isPending ? "loading" : extensions.isError ? "unavailable" : "ready"}
                  imageCapabilitiesReady={!models.isPending}
                  draft={draft}
                  setDraft={setDraft}
                  onSend={(behavior) => submitDraft(behavior)}
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
                  editingMessage={editingMessage && editingMessage.sessionId === current.id ? { messageId: editingMessage.messageId, hadAttachments: editingMessage.hadAttachments } : undefined}
                  onCancelEdit={() => cancelEdit()}
                  onOpenModelSettings={() => openSettings("models")}
                  subagents={liveSubagents[current.id]}
                />
              </>
            ) : currentId && detail.isLoading ? (
              // 会话详情首次加载中：渲染对话骨架，避免欢迎页闪烁
              <SessionSkeleton />
            ) : (
              <EmptyState
                sessions={sessions.data ?? []}
                providers={providers.data}
                onSelect={selectSession}
                onCreate={() => setDialogOpen(true)}
                onOpenSettings={openSettings}
                onExample={(text) => {
                  void writeClipboard(text).then((ok) => notify(
                    ok ? t("已复制到剪贴板，粘贴进会话输入框发送", "Copied to clipboard — paste into the composer to send") : t("复制失败", "Copy failed"),
                    ok ? "info" : "error",
                  ));
                }}
              />
            )}
            </section>
            {editorPane && currentId && !isMobile && (
              <Suspense fallback={null}>
                <EditorPane
                  sessionId={currentId}
                  path={editorPane.path}
                  {...(editorPane.line !== undefined ? { line: editorPane.line } : {})}
                  {...(editorPane.column !== undefined ? { column: editorPane.column } : {})}
                  readOnly={current?.agentMode === "plan"}
                  dark={theme === "dark"}
                  actionsRef={editorActionsRef}
                  onClose={closeEditor}
                  onNotice={notify}
                />
              </Suspense>
            )}
            {diffPane && currentId && !isMobile && (
              <Suspense fallback={null}>
                <DiffPane
                  sessionId={currentId}
                  spec={diffPane}
                  readOnly={current?.agentMode === "plan"}
                  dark={theme === "dark"}
                  actionsRef={diffActionsRef}
                  onClose={closeDiff}
                  onNotice={notify}
                />
              </Suspense>
            )}
          </div>
        }
        bottom={
          <BottomPanel
            sessionId={currentId}
            session={current}
            running={running}
            windowUsage={windowInfo}
            subagentRuns={subagentRuns}
            {...(latestUsage ? { latestUsage } : {})}
            {...(!isMobile && current ? {
              status: {
                state: currentState,
                tokens: costSummary?.tokens,
                costLabel: costSummary?.costLabel,
                windowPercent: windowInfo?.utilization !== undefined ? Math.round(windowInfo.utilization * 100) : undefined,
              },
            } : {})}
            evalEnabled={extensions.data?.some((extension) => extension.id === "owc-eval" && extension.enabled) === true}
            onNotice={notify}
            open={layout.bottomOpen}
            onOpenChange={layout.setBottomOpen}
            onOpenDiff={openDiff}
            onForkSession={(newSessionId) => setCurrentId(newSessionId)}
            {...(!isMobile ? { onOpenSubagentTab: openSubagentTab } : {})}
          />
        }
        // 桌面端状态项已并入 BottomPanel 标签条；状态栏仅移动端保留（底部面板在移动端为覆盖层）
        statusBar={isMobile && current ? (
          <StatusBar
            session={current}
            state={currentState}
            tokens={costSummary?.tokens}
            costLabel={costSummary?.costLabel}
            indexStatus={indexStatus.data?.status}
            {...(windowInfo?.utilization !== undefined ? { windowPercent: Math.round(windowInfo.utilization * 100) } : {})}
          />
        ) : null}
      />
      <input
        ref={importInput}
        type="file"
        accept=".jsonl,.ndjson,.txt,application/x-ndjson"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) importSession(file);
          event.target.value = "";
        }}
      />
      <NewSessionDialog
        open={dialogOpen}
        providers={providers.data ?? []}
        models={models.data ?? []}
        defaults={sessionDefaults}
        busy={create.isPending}
        onClose={() => setDialogOpen(false)}
        onCreate={(values) => create.mutate(values)}
        onOpenSettings={(tab) => { setDialogOpen(false); openSettings(tab); }}
      />
      <SettingsDialog
        open={settingsOpen}
        {...(settingsTab !== undefined ? { initialTab: settingsTab.tab, initialTabAt: settingsTab.at } : {})}
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
      <ConfirmDeleteDialog
        open={deleteTarget !== undefined}
        title={sessions.data?.find((session) => session.id === deleteTarget)?.title ?? deleteTarget ?? ""}
        running={deleteTarget !== undefined && runningIds.has(deleteTarget)}
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={confirmDelete}
      />
      <Suspense fallback={null}>
        {paletteOpen && <CommandPalette open={paletteOpen} context={whenContext} onClose={() => setPaletteOpen(false)} />}
        {quickOpenOpen && currentId && (
          <QuickOpen
            open={quickOpenOpen}
            sessionId={currentId}
            onOpenFile={(path) => setCodeOverlayPath(path)}
            onOpenInEditor={isMobile ? undefined : (path) => openEditor(path)}
            onClose={() => setQuickOpenOpen(false)}
          />
        )}
        {shortcutsOpen && <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />}
        {notificationsOpen && (
          <NotificationsOverlay
            open={notificationsOpen}
            notifications={notifications}
            onActivate={activateNotification}
            onDismiss={(id) => setNotifications((previous) => removeNotification(previous, id))}
            onClearAll={() => setNotifications(clearNotifications())}
            onClose={closeNotifications}
          />
        )}
        {codeOverlayPath && currentId && (
          <CodeOverlay
            sessionId={currentId}
            path={codeOverlayPath}
            onEdit={isMobile ? undefined : (path) => openEditor(path)}
            onClose={() => setCodeOverlayPath(undefined)}
          />
        )}
        {/* 移动端 diff 降级：只读摘要浮层（不加载 Monaco、不写回），桌面端走编辑器区分栏 */}
        {diffPane && currentId && isMobile && (
          <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDiff(); }}>
            <div className="wb-overlay code-overlay" role="dialog" aria-modal="true" aria-label={t("变更摘要", "Change summary")}>
              <DiffPane
                sessionId={currentId}
                spec={diffPane}
                summaryOnly
                dark={theme === "dark"}
                onClose={closeDiff}
                onNotice={notify}
              />
            </div>
          </div>
        )}
      </Suspense>
      {notice && <Toast notice={notice} onDismiss={() => setNotice(undefined)} />}
      {/* 事件流断线重连提示：仅展示不阻塞交互，恢复后自动消失 */}
      {reconnecting && (
        <div className="connection-banner" role="status">
          {t("连接中断，正在重连…", "Connection lost, reconnecting…")}
        </div>
      )}
    </>
  );
}
