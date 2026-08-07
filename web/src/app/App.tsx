/**
 * 新根组件（webui-rewrite 装配层）：主题、查询、WS 接线（wiring）、会话 CRUD、全局对话框与提示。
 * 会话区细节在 chat/ChatView.tsx；外壳在 workbench/Workbench.tsx。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SessionDetail } from "../lib/contracts";
import { qk, useModelsQuery, useProvidersQuery, useServerSettingsQuery, useSessionQuery, useSessionsQuery, useUpdateCheckQuery } from "./queries";
import { useStore } from "./store";
import { ui, uiStore } from "./ui-store";
import { sessionMeta, sessionStore } from "./session-store";
import { useAppWiring } from "./wiring";
import { isBusyState } from "../lib/agent-state";
import { pruneDrafts } from "../lib/drafts";
import { writeClipboard } from "../lib/clipboard";
import { deriveSubagentRunsFromMessages, mergeSubagentRuns } from "../lib/subagent-runs";
import { useSessionDefaults } from "./prefs-store";
import { useTheme } from "../theme";
import { useI18n } from "../i18n";
import { useAgentRun } from "../hooks/use-agent-run";
import { useSubagentTabs } from "../hooks/use-subagent-tabs";
import { useTerminalTabs } from "../hooks/use-terminal-tabs";
import { live, liveStore } from "./live-store";
import { Workbench } from "../workbench/Workbench";
import { layout } from "../workbench/layout";
import { auxViews, auxViewsStore, diffActions, editorActions, useAuxViews } from "../workbench/aux-views";
import { tabActions } from "../workbench/tab-actions";
import { ChatView } from "../chat/ChatView";
import { streamBuffer } from "../chat/stream-buffer";
import { clearComposerState } from "../composer/drafts";
import { EmptyState } from "../components/EmptyState";
import { NewSessionDialog, type NewSessionValues } from "../components/NewSessionDialog";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { Toast } from "../components/Toast";

// 辅助视图各自独立 chunk，仅打开时加载，不占入口体积
const CodeOverlay = lazy(() => import("../components/CodeOverlay").then((m) => ({ default: m.CodeOverlay })));
const EditorPane = lazy(() => import("../components/editor/EditorPane").then((m) => ({ default: m.EditorPane })));
const DiffPane = lazy(() => import("../components/editor/DiffPane").then((m) => ({ default: m.DiffPane })));

export function App(): ReactElement {
  const { t } = useI18n();
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const sessionId = useStore(uiStore, (state) => state.sessionId);
  const notice = useStore(uiStore, (state) => state.notice);
  const newSessionOpen = useStore(uiStore, (state) => state.newSessionOpen);
  const deleteTarget = useStore(uiStore, (state) => state.deleteTarget);
  const agentStates = useStore(sessionStore, (state) => state.agentStates);
  const sessions = useSessionsQuery();
  const models = useModelsQuery();
  const providers = useProvidersQuery();
  const serverSettings = useServerSettingsQuery();
  const updateCheck = useUpdateCheckQuery();
  const sessionDefaults = useSessionDefaults();
  const agentRun = useAgentRun(sessionId);
  const subagentTabs = useSubagentTabs();
  const terminalTabs = useTerminalTabs();
  // 编辑器/diff 的 plan 只读门禁需要当前会话 agentMode（与 ChatView 共享同一查询缓存，不额外发请求）
  const currentDetail = useSessionQuery(sessionId);
  // 主区辅助视图（编辑器分栏 / diff / 代码浮层，三者互斥）
  const aux = useAuxViews();
  // EditorPane/DiffPane 的 actionsRef 形状为 { current }：包一层指向 aux-views 的动作面单例
  const editorActionsRef = useMemo(() => ({ current: editorActions }), []);
  const diffActionsRef = useMemo(() => ({ current: diffActions }), []);

  // 新会话永远回到纯对话：切换会话即关闭全部辅助视图（布局回归约束）
  useEffect(() => {
    auxViews.closeAll();
  }, [sessionId]);

  // 标签动作桥：深层组件（子代理面板「在标签中打开」、活动栏终端入口）经 tabActions 触达本装配层
  useEffect(() => {
    tabActions.openSubagentTab = (toolCallId) => {
      const id = uiStore.get().sessionId;
      if (!id) return;
      // 从合并运行记录取标签字段（实时优先 + 消息推导补齐历史），创建并聚焦；关闭标记由 openTab 清除
      const detail = queryClient.getQueryData<SessionDetail>(qk.session(id));
      const runs = mergeSubagentRuns(liveStore.get().subagents[id] ?? {}, deriveSubagentRunsFromMessages(detail?.messages ?? []));
      const run = Object.values(runs).find((entry) => entry.toolCallId === toolCallId);
      if (!run) return;
      subagentTabs.openTab(id, {
        toolCallId,
        prompt: run.prompt,
        ...(run.agent ? { agent: run.agent } : {}),
        ...(run.swarm ? { swarmTotal: run.swarm.total } : {}),
      });
      terminalTabs.setTerminalSelected(id, false);
    };
    tabActions.openTerminal = () => {
      const id = uiStore.get().sessionId;
      if (!id) return;
      terminalTabs.openTerminal(id);
      subagentTabs.selectTab(id, undefined);
    };
    return () => {
      tabActions.openSubagentTab = undefined;
      tabActions.openTerminal = undefined;
    };
  }, [queryClient, subagentTabs, terminalTabs]);

  // 编辑器/diff 键盘动作（命令体系 Phase 3 再统管）：mod+s 保存、mod+\ 焦点切换、Esc 关闭。
  // Esc/保存兜底：EditorPane/DiffPane 挂载后自行在 capture 阶段处理 Esc（含未保存确认）并 stopPropagation，
  // 本监听只在面板尚未挂上自己的监听（如懒加载途中）时生效。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        if (!auxViewsStore.get().editor) return;
        event.preventDefault();
        editorActions.save?.();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && event.key === "\\") {
        const state = auxViewsStore.get();
        if (!state.editor && !state.diff) return;
        event.preventDefault();
        const inPane = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".editor-pane"));
        if (inPane) document.getElementById("composer-input")?.focus();
        else (editorActions.focus ?? diffActions.focus)?.();
        return;
      }
      if (event.key === "Escape") {
        const state = auxViewsStore.get();
        if (state.editor) {
          auxViews.closeEditor();
          document.getElementById("composer-input")?.focus();
        } else if (state.diff) {
          auxViews.closeDiff();
          document.getElementById("composer-input")?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // diff/编辑器关闭后焦点回 Composer（对话为主约束）
  const focusComposer = useCallback((): void => {
    document.getElementById("composer-input")?.focus();
  }, []);
  const closeEditor = useCallback((): void => {
    auxViews.closeEditor();
    focusComposer();
  }, [focusComposer]);
  const closeDiff = useCallback((): void => {
    auxViews.closeDiff();
    focusComposer();
  }, [focusComposer]);

  // WS 事件流 + 路由接线（t 经 ref 取最新，语言切换后通知文案跟随）
  const tRef = useRef(t);
  tRef.current = t;
  const sessionsRef = useRef(sessions.data);
  sessionsRef.current = sessions.data;
  const { reconnecting, routerRef } = useAppWiring({
    queryClient,
    getT: () => tRef.current,
    getSessions: () => sessionsRef.current,
    applyRunEvent: agentRun.applyEvent,
    onSubagentStarted: subagentTabs.openFromStarted,
  });

  // 启动后自动选中首个会话
  useEffect(() => {
    if (!sessionId && sessions.data?.[0]) ui.selectSession(sessions.data[0].id);
  }, [sessionId, sessions.data]);
  // 会话列表加载后修剪已删除会话残留的草稿键
  useEffect(() => {
    if (sessions.data) pruneDrafts(new Set(sessions.data.map((session) => session.id)));
  }, [sessions.data]);

  // 新版本提示：更新检查启用且发现更新版本时通知中心提示一次（按版本去重，点击跳转 设置 → 服务信息）
  const notifiedUpdateVersionsRef = useRef(new Set<string>());
  useEffect(() => {
    const enabled = serverSettings.data?.groups.some((group) =>
      group.fields.some((field) => field.key === "updateCheckEnabled" && field.value === true)) === true;
    const snapshot = updateCheck.data?.snapshot;
    if (!enabled || !snapshot?.isNewer || notifiedUpdateVersionsRef.current.has(snapshot.latestVersion)) return;
    notifiedUpdateVersionsRef.current.add(snapshot.latestVersion);
    ui.pushEventNotification(t(`发现新版本 v${snapshot.latestVersion}，前往 设置 → 服务信息 更新`, `New version v${snapshot.latestVersion} available — go to Settings → Server info to update`), "info", { settingsTab: "info" });
  }, [serverSettings.data, updateCheck.data, t]);

  const fail = (chinese: string, english: string) => (error: unknown): void =>
    ui.notify(error instanceof Error ? error.message : t(chinese, english), "error");

  const create = useMutation({
    mutationFn: (values: NewSessionValues) => api.createSession(values),
    onSuccess: (session, values) => {
      ui.setNewSessionOpen(false);
      ui.selectSession(session.id);
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      // 权限模式不在创建接口内，创建后单独应用
      if (values.permissionMode && values.permissionMode !== "ask") {
        api.updateSession(session.id, { permissionMode: values.permissionMode })
          .then(() => queryClient.invalidateQueries({ queryKey: qk.session(session.id) }))
          .catch(fail("权限模式应用失败", "Could not apply permission mode"));
      }
    },
    onError: fail("创建会话失败", "Could not create session"),
  });

  // 删除确认对话框：点删除只打开确认，确认后才真正 DELETE
  const confirmDelete = (): void => {
    const id = deleteTarget;
    ui.setDeleteTarget(undefined);
    if (!id) return;
    api.deleteSession(id)
      .then(() => {
        if (sessionId === id) ui.selectSession(sessions.data?.find((session) => session.id !== id)?.id);
        // 同步清理按会话键控的内存状态，避免已删会话的条目残留
        sessionMeta.removeSession(id);
        live.removeSession(id);
        subagentTabs.removeSession(id);
        terminalTabs.removeSession(id);
        clearComposerState(id);
        streamBuffer.discard(id);
        routerRef.current?.forgetSession(id);
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
      })
      .catch(fail("删除会话失败", "Could not delete session"));
  };

  const currentState = agentRun.data?.state ?? (sessionId ? agentStates[sessionId] : undefined);
  const runningIds = useMemo(() => new Set(Object.entries(agentStates).filter(([, state]) => isBusyState(state)).map(([id]) => id)), [agentStates]);
  const openNavMenu = (): void => layout.setMobileNavOpen(true);
  const onExample = (text: string): void => {
    const copied = t("已复制到剪贴板，粘贴进会话输入框发送", "Copied to clipboard — paste into the composer to send");
    void writeClipboard(text).then((ok) => ui.notify(ok ? copied : t("复制失败", "Copy failed"), ok ? "info" : "error"));
  };
  const main = sessionId ? (
    <div className="wb-main-split">
      <ChatView sessionId={sessionId} currentRun={agentRun.data} subagentTabs={subagentTabs} terminalTabs={terminalTabs} onOpenNavMenu={openNavMenu} />
      {aux.editor && (
        <Suspense fallback={null}>
          <EditorPane
            sessionId={sessionId}
            path={aux.editor.path}
            {...(aux.editor.line !== undefined ? { line: aux.editor.line } : {})}
            {...(aux.editor.column !== undefined ? { column: aux.editor.column } : {})}
            readOnly={currentDetail.data?.agentMode === "plan"}
            dark={theme === "dark"}
            actionsRef={editorActionsRef}
            onClose={closeEditor}
            onNotice={ui.notify}
          />
        </Suspense>
      )}
      {aux.diff && (
        <Suspense fallback={null}>
          <DiffPane
            sessionId={sessionId}
            spec={aux.diff}
            readOnly={currentDetail.data?.agentMode === "plan"}
            dark={theme === "dark"}
            actionsRef={diffActionsRef}
            onClose={closeDiff}
            onNotice={ui.notify}
          />
        </Suspense>
      )}
    </div>
  ) : (
    <section className="workbench">
      <EmptyState sessions={sessions.data ?? []} providers={providers.data} onSelect={(id) => ui.selectSession(id)}
        onCreate={() => ui.setNewSessionOpen(true)} onOpenSettings={(tab) => ui.openSettings(tab)}
        onOpenNavMenu={openNavMenu} onExample={onExample} />
    </section>
  );

  return (
    <>
      <Workbench sessions={sessions.data} agentState={currentState} main={main} />
      <NewSessionDialog
        open={newSessionOpen}
        providers={providers.data ?? []}
        models={models.data ?? []}
        defaults={sessionDefaults}
        busy={create.isPending}
        onClose={() => ui.setNewSessionOpen(false)}
        onCreate={(values) => create.mutate(values)}
        onOpenSettings={(tab) => { ui.setNewSessionOpen(false); ui.openSettings(tab); }}
      />
      <ConfirmDeleteDialog
        open={deleteTarget !== undefined}
        title={sessions.data?.find((session) => session.id === deleteTarget)?.title ?? deleteTarget ?? ""}
        running={deleteTarget !== undefined && runningIds.has(deleteTarget)}
        onCancel={() => ui.setDeleteTarget(undefined)}
        onConfirm={confirmDelete}
      />
      {notice && <Toast notice={notice} onDismiss={() => ui.setNotice(undefined)} />}
      {/* 只读代码浮层（Quick Open 打开；与编辑器/diff 互斥由 aux-views 保证） */}
      {aux.codeOverlay && sessionId && (
        <Suspense fallback={null}>
          <CodeOverlay
            sessionId={sessionId}
            path={aux.codeOverlay}
            onEdit={(path) => auxViews.openEditor(path)}
            onClose={() => auxViews.closeCodeOverlay()}
          />
        </Suspense>
      )}
      {/* 事件流断线重连提示：仅展示不阻塞交互，恢复后自动消失 */}
      {reconnecting && <div className="connection-banner" role="status">{t("连接中断，正在重连…", "Connection lost, reconnecting…")}</div>}
    </>
  );
}
