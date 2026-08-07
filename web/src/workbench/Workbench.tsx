/**
 * 工作台外壳：桌面 grid [活动栏 | 侧栏 | 主区] + 底部状态条；
 * 移动端（≤1024px）单列 + 侧栏 fixed 抽屉 + 遮罩 + Esc 关闭 + 选中会话自动收起。
 * 布局偏好持久化在 layout.ts（旧 localStorage 键名沿用）。
 * BottomPanel（底部面板区）Phase 2 接入；F6 区域轮换随命令体系 Phase 3 接入。
 */
import { useEffect, type ReactElement, type ReactNode } from "react";
import type { Session } from "../lib/contracts";
import { unreadCount } from "../lib/notifications";
import { useStore } from "../app/store";
import { ui, uiStore } from "../app/ui-store";
import { sessionMeta, sessionStore } from "../app/session-store";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";
import { useI18n } from "../i18n";
import { layout, layoutStore, type SidebarView } from "./layout";
import { ActivityBar, MobileNavMenu, type RailActions } from "./Rail";
import { SidebarViews } from "./SidebarViews";
import { BottomPanel } from "./BottomPanel";
import { StatusBar } from "./StatusBar";

export interface WorkbenchProps {
  /** 会话列表（undefined = 加载中） */
  sessions?: Session[] | undefined;
  /** 当前会话 agent 运行态（App 由 useAgentRun/sessionStore 推导） */
  agentState?: string | undefined;
  main: ReactNode;
}

export function Workbench({ sessions, agentState, main }: WorkbenchProps): ReactElement {
  const { t } = useI18n();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const layoutState = useStore(layoutStore, (state) => state);
  const currentId = useStore(uiStore, (state) => state.sessionId);
  const agentStates = useStore(sessionStore, (state) => state.agentStates);
  const problemsBadges = useStore(sessionStore, (state) => state.problemsBadges);
  const notifications = useStore(uiStore, (state) => state.notifications);

  // 窄窗口抽屉只在当前视口内开合，不污染桌面侧栏的持久化展开状态
  const sidebarVisible = isMobile ? layoutState.mobileSidebarOpen : layoutState.sidebarVisible;
  useEffect(() => {
    if (!isMobile) layout.setMobileSidebarOpen(false);
  }, [isMobile]);
  // 移动端抽屉：Esc 关闭（点击遮罩关闭由 backdrop 的 onClick 承担）
  useEffect(() => {
    if (!isMobile || !sidebarVisible) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") layout.setMobileSidebarOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile, sidebarVisible]);
  // 打开 Problems 侧栏视图即视为已查看，清除角标
  const problemsBadge = currentId ? problemsBadges[currentId] ?? 0 : 0;
  useEffect(() => {
    if (layoutState.sidebarView === "problems" && sidebarVisible && currentId) {
      sessionMeta.clearProblemsBadge(currentId);
    }
  }, [layoutState.sidebarView, sidebarVisible, currentId]);

  const showView = (view: SidebarView): void => {
    if (!isMobile) {
      layout.showView(view);
      return;
    }
    // 移动端：点当前视图图标收起抽屉，否则切换视图并展开抽屉
    if (layoutState.mobileSidebarOpen && layoutState.sidebarView === view) {
      layout.setMobileSidebarOpen(false);
      return;
    }
    layout.selectView(view);
    layout.setMobileSidebarOpen(true);
  };

  // 移动端抽屉：选中会话后收起侧栏（桌面端行为不变）
  const selectSession = (id: string): void => {
    ui.selectSession(id);
    if (isMobile) layout.setMobileSidebarOpen(false);
  };

  const railActions: RailActions = {
    activeView: layoutState.sidebarView,
    problemsBadge,
    notificationsBadge: unreadCount(notifications),
    onShowView: showView,
    onShowHelp: () => ui.openSettings("shortcuts"),
    onShowNotifications: () => ui.openSettings("notifications"),
    onOpenSettings: () => ui.openSettings(),
  };

  const sidebarContent = (
    <SidebarViews sessions={sessions} currentId={currentId} agentStates={agentStates} onSelectSession={selectSession} />
  );

  const currentSession = sessions?.find((session) => session.id === currentId);

  return (
    <div
      className="console-shell wb-shell"
      style={isMobile ? undefined : { gridTemplateColumns: sidebarVisible ? `48px ${layoutState.sidebarWidth}px minmax(0, 1fr)` : "48px minmax(0, 1fr)" }}
    >
      {/* 窄屏不渲染桌面活动栏：导航入口由左上角 logo 触发的左侧滑出菜单承担 */}
      {!isMobile && (
        <div className="wb-zone wb-activity" data-wb-zone="activity" tabIndex={-1} role="navigation" aria-label={t("活动栏", "Activity Bar")}>
          <ActivityBar {...railActions} sidebarVisible={layoutState.sidebarVisible} onToggleSidebar={layout.toggleSidebar} />
        </div>
      )}
      {isMobile && (
        <MobileNavMenu open={layoutState.mobileNavOpen} onClose={() => layout.setMobileNavOpen(false)} {...railActions} />
      )}
      {isMobile && sidebarVisible && (
        <div className="wb-sidebar-backdrop" aria-hidden onClick={() => layout.setMobileSidebarOpen(false)} />
      )}
      {sidebarVisible && (
        <div className="wb-zone wb-sidebar" data-wb-zone="sidebar" tabIndex={-1} role="complementary" aria-label={t("侧边栏", "Sidebar")}>
          {sidebarContent}
        </div>
      )}
      <div className="wb-zone wb-main" data-wb-zone="main" tabIndex={-1} role="main" aria-label={t("对话", "Conversation")}>
        {main}
      </div>
      <BottomPanel sessionId={currentId} agentState={agentState} mobile={isMobile} />
      <div className="wb-status">
        <StatusBar sessionId={currentId} session={currentSession} agentState={agentState} mobile={isMobile} />
      </div>
    </div>
  );
}
