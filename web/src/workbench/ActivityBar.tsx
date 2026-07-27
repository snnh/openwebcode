/**
 * 活动栏（VSCode 风格左侧窄图标栏，0.4.0 Phase 5a）：
 * 上部为侧栏视图切换（会话/文件/SCM/问题），下部为命令面板与设置入口。
 */
import type { ReactElement } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useI18n } from "../i18n";
import type { SidebarView } from "./useWorkbenchLayout";

const VIEW_META: Record<SidebarView, { zh: string; en: string; icon: IconName }> = {
  sessions: { zh: "会话", en: "Sessions", icon: "history" },
  files: { zh: "文件", en: "Files", icon: "folder" },
  scm: { zh: "源代码管理", en: "Source Control", icon: "git" },
  problems: { zh: "问题", en: "Problems", icon: "alert" },
};

export function ActivityBar({ activeView, sidebarVisible, problemsBadge = 0, notificationsBadge = 0, onShowView, onShowCommands, onShowNotifications, onOpenSettings }: {
  activeView: SidebarView;
  sidebarVisible: boolean;
  /** 未查看的诊断失败数角标（diagnostics.updated，不弹窗不打断） */
  problemsBadge?: number;
  /** 未读通知数角标（0.4.0 Phase 5b 通知中心） */
  notificationsBadge?: number;
  onShowView(view: SidebarView): void;
  onShowCommands(): void;
  onShowNotifications(): void;
  onOpenSettings(): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="activity-bar">
      <span className="activity-mobile-brand" aria-hidden>Open<b>WebCode</b></span>
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
      <div className="activity-bar-bottom">
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
        <button className="activity-btn" aria-label={t("命令面板", "Command Palette")} title={t("命令面板（Ctrl+Shift+P）", "Command Palette (Ctrl+Shift+P)")} onClick={onShowCommands}>
          <Icon name="terminal" size={20} />
        </button>
        <button className="activity-btn" aria-label={t("设置", "Settings")} title={t("设置（Ctrl+,）", "Settings (Ctrl+,)")} onClick={onOpenSettings}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    </div>
  );
}
