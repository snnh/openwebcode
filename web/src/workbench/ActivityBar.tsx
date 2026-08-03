/**
 * 活动栏（VSCode 风格左侧窄图标栏，0.4.0 Phase 5a）：
 * 上部为侧栏视图切换（会话/文件/SCM/问题），下部为帮助/通知/终端/设置入口。
 * 命令面板不走活动栏，仅保留 Ctrl+Shift+P 快捷键。
 */
import type { ReactElement } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import type { SidebarView } from "./useWorkbenchLayout";
import { VIEW_META } from "./view-meta";

export function ActivityBar({ activeView, sidebarVisible, problemsBadge = 0, notificationsBadge = 0, terminalDisabled = false, terminalActive = false, onShowView, onToggleSidebar, onShowHelp, onShowNotifications, onOpenTerminal, onOpenSettings }: {
  activeView: SidebarView;
  sidebarVisible: boolean;
  /** 未查看的诊断失败数角标（diagnostics.updated，不弹窗不打断） */
  problemsBadge?: number;
  /** 未读通知数角标（0.4.0 Phase 5b 通知中心） */
  notificationsBadge?: number;
  /** 无当前会话时禁用终端入口 */
  terminalDisabled?: boolean;
  /** 终端标签选中态（窄屏底部导航高亮当前所在区） */
  terminalActive?: boolean;
  onShowView(view: SidebarView): void;
  /** 展开/收起侧边栏（按钮在活动栏中段，悬浮/聚焦才显示） */
  onToggleSidebar(): void;
  /** 帮助与快捷键（打开快捷键速查对话框） */
  onShowHelp(): void;
  onShowNotifications(): void;
  /** 打开并选中当前会话的终端标签 */
  onOpenTerminal(): void;
  onOpenSettings(): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        {(Object.keys(VIEW_META) as SidebarView[]).map((view) => {
          const meta = VIEW_META[view];
          const active = sidebarVisible && activeView === view;
          return (
            <button
              key={view}
              className={`activity-btn${active ? " active" : ""}`}
              aria-pressed={active}
              aria-label={t(meta.zh, meta.en)}
              title={t(meta.zh, meta.en)}
              onClick={() => onShowView(view)}
            >
              <Icon name={meta.icon} size={20} />
              {view === "problems" && problemsBadge > 0 && !active && (
                <span className="activity-badge" aria-label={t(`${problemsBadge} 个新问题`, `${problemsBadge} new problem(s)`)}>{problemsBadge}</span>
              )}
            </button>
          );
        })}
      </div>
      <button
        className="activity-btn activity-collapse-btn"
        aria-label={sidebarVisible ? t("收起侧边栏", "Collapse sidebar") : t("展开侧边栏", "Expand sidebar")}
        title={sidebarVisible ? t("收起侧边栏（Ctrl+B）", "Collapse sidebar (Ctrl+B)") : t("展开侧边栏（Ctrl+B）", "Expand sidebar (Ctrl+B)")}
        onClick={onToggleSidebar}
      >
        <Icon name={sidebarVisible ? "chevrons-left" : "chevrons-right"} size={20} />
      </button>
      <div className="activity-bar-bottom">
        <button
          className="activity-btn"
          aria-label={t("帮助与快捷键", "Help & keyboard shortcuts")}
          title={t("帮助与快捷键", "Help & keyboard shortcuts")}
          onClick={onShowHelp}
        >
          <Icon name="help" size={20} />
        </button>
        <button
          className="activity-btn"
          aria-label={notificationsBadge > 0 ? t(`通知中心（${notificationsBadge} 条未读）`, `Notifications (${notificationsBadge} unread)`) : t("通知中心", "Notifications")}
          title={t("通知中心", "Notifications")}
          onClick={onShowNotifications}
        >
          <Icon name="bell" size={20} />
          {notificationsBadge > 0 && (
            <span className="activity-badge" aria-hidden>{notificationsBadge > 99 ? "99+" : notificationsBadge}</span>
          )}
        </button>
        <button
          className={`activity-btn${terminalActive ? " active" : ""}`}
          aria-label={t("终端", "Terminal")}
          aria-pressed={terminalActive}
          title={t("终端", "Terminal")}
          disabled={terminalDisabled}
          onClick={onOpenTerminal}
        >
          <Icon name="terminal" size={20} />
        </button>
        <button className="activity-btn" aria-label={t("设置", "Settings")} title={t("设置（Ctrl+,）", "Settings (Ctrl+,)")} onClick={onOpenSettings}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    </div>
  );
}
