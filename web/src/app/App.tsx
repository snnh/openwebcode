/**
 * 新根组件（webui-rewrite 装配层）：主题、查询、WS 接线（wiring）、会话 CRUD、全局对话框与提示。
 * 会话区细节在 chat/ChatView.tsx；外壳在 workbench/Workbench.tsx。
 */
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk, useModelsQuery, useProvidersQuery, useServerSettingsQuery, useSessionsQuery, useUpdateCheckQuery } from "./queries";
import { useStore } from "./store";
import { ui, uiStore } from "./ui-store";
import { sessionMeta, sessionStore } from "./session-store";
import { useAppWiring } from "./wiring";
import { isBusyState } from "../lib/agent-state";
import { pruneDrafts } from "../lib/drafts";
import { writeClipboard } from "../lib/clipboard";
import { useSessionDefaults } from "./prefs-store";
import { useTheme } from "../theme";
import { useI18n } from "../i18n";
import { useAgentRun } from "../hooks/use-agent-run";
import { useLiveActivity } from "../hooks/use-live-activity";
import { useLiveSubagents } from "../hooks/use-live-subagents";
import { useSubagentTabs } from "../hooks/use-subagent-tabs";
import { useTerminalTabs } from "../hooks/use-terminal-tabs";
import type { LiveSubagentRun } from "../lib/contracts";
import { Workbench } from "../workbench/Workbench";
import { layout } from "../workbench/layout";
import { ChatView } from "../chat/ChatView";
import { streamBuffer } from "../chat/stream-buffer";
import { clearComposerState } from "../composer/drafts";
import { EmptyState } from "../components/EmptyState";
import { NewSessionDialog, type NewSessionValues } from "../components/NewSessionDialog";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { Toast } from "../components/Toast";

const EMPTY_SUBAGENTS: Record<string, LiveSubagentRun> = {};

export function App(): ReactElement {
  const { t } = useI18n();
  useTheme();
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
  const liveActivity = useLiveActivity();
  const subagentTabs = useSubagentTabs();
  const terminalTabs = useTerminalTabs();
  const liveSubagents = useLiveSubagents({ dropOnToolEnd: false, onStarted: subagentTabs.openFromStarted });

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
    applyActivityEvent: liveActivity.applyEvent,
    applySubagentEvent: liveSubagents.applyEvent,
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
        liveSubagents.removeSession(id);
        subagentTabs.removeSession(id);
        terminalTabs.removeSession(id);
        clearComposerState(id);
        streamBuffer.discard(id);
        routerRef.current?.forgetSession(id);
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
      })
      .catch(fail("删除会话失败", "Could not delete session"));
  };

  // 会话显示属性（重命名/置顶，Phase 2 会话列表操作接入）：PATCH 后刷新列表与当前详情
  const patchSession = useMutation({
    mutationFn: (input: { id: string; body: { title?: string; pinned?: boolean } }) => api.patchSession(input.id, input.body),
    onSuccess: (_updated, input) => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      if (input.id === sessionId) void queryClient.invalidateQueries({ queryKey: qk.session(input.id) });
    },
    onError: fail("更新会话失败", "Could not update session"),
  });
  void patchSession; // Phase 2 会话项操作接入后使用

  const importSession = (file: File): void => {
    file.text()
      .then((text) => api.importSession(text))
      .then((session) => {
        ui.notify(t(`已导入会话「${session.title}」`, `Imported session “${session.title}”`));
        ui.selectSession(session.id);
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
      })
      .catch(fail("导入失败", "Import failed"));
  };
  void importSession; // Phase 2 会话列表导入入口接入后使用

  const currentState = agentRun.data?.state ?? (sessionId ? agentStates[sessionId] : undefined);
  const runningIds = useMemo(() => new Set(Object.entries(agentStates).filter(([, state]) => isBusyState(state)).map(([id]) => id)), [agentStates]);
  const openNavMenu = (): void => layout.setMobileNavOpen(true);
  const onExample = (text: string): void => {
    const copied = t("已复制到剪贴板，粘贴进会话输入框发送", "Copied to clipboard — paste into the composer to send");
    void writeClipboard(text).then((ok) => ui.notify(ok ? copied : t("复制失败", "Copy failed"), ok ? "info" : "error"));
  };
  const main = sessionId ? (
    <ChatView sessionId={sessionId} currentRun={agentRun.data} activityFor={liveActivity.activityFor}
      liveSubagents={liveSubagents.liveSubagents[sessionId] ?? EMPTY_SUBAGENTS} onOpenNavMenu={openNavMenu} />
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
      {/* 事件流断线重连提示：仅展示不阻塞交互，恢复后自动消失 */}
      {reconnecting && <div className="connection-banner" role="status">{t("连接中断，正在重连…", "Connection lost, reconnecting…")}</div>}
    </>
  );
}
