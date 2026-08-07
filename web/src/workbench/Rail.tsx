/**
 * 活动栏（桌面左侧窄图标栏）与移动端导航：
 * 上部为侧栏视图切换（会话/文件/SCM/问题），下部为帮助/通知/设置入口。
 */
import { useEffect, useRef, type ReactElement } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useI18n } from "../i18n";
import type { SidebarView } from "./layout";

/** 侧栏视图元信息（桌面活动栏与移动端导航共用） */
export const VIEW_META: Record<SidebarView, { zh: string; en: string; icon: IconName }> = {
  sessions: { zh: "会话", en: "Sessions", icon: "history" },
  files: { zh: "文件", en: "Files", icon: "folder" },
  scm: { zh: "源代码管理", en: "Source Control", icon: "git" },
  problems: { zh: "问题", en: "Problems", icon: "alert" },
};

/** 桌面活动栏与移动端导航共用的入口参数 */
export interface RailActions {
  activeView: SidebarView;
  /** 未查看的诊断失败数角标（diagnostics.updated，不弹窗不打断） */
  problemsBadge?: number;
  /** 未读通知数角标 */
  notificationsBadge?: number;
  onShowView(view: SidebarView): void;
  /** 帮助与快捷键（打开设置「快捷键」页签） */
  onShowHelp(): void;
  onShowNotifications(): void;
  onOpenSettings(): void;
}

export interface ActivityBarProps extends RailActions {
  /** 活动视图高亮需同时满足侧栏展开 */
  sidebarVisible: boolean;
  /** 展开/收起侧边栏（按钮在活动栏中段，悬浮/聚焦才显示） */
  onToggleSidebar(): void;
}

export function ActivityBar({ activeView, sidebarVisible, problemsBadge = 0, notificationsBadge = 0, onShowView, onToggleSidebar, onShowHelp, onShowNotifications, onOpenSettings }: ActivityBarProps): ReactElement {
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
        <button className="activity-btn" aria-label={t("设置", "Settings")} title={t("设置（Ctrl+,）", "Settings (Ctrl+,)")} onClick={onOpenSettings}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    </div>
  );
}

/** 移动端左上角导航菜单触发钮（面板图标；仅移动端由 CSS 显示） */
export function MobileNavTrigger({ onOpen }: { onOpen(): void }): ReactElement {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="mobile-nav-trigger"
      aria-label={t("打开导航菜单", "Open navigation menu")}
      title={t("导航菜单", "Navigation menu")}
      onClick={onOpen}
    >
      <Icon name="panel-left" size={20} />
    </button>
  );
}

/**
 * 移动端导航菜单（≤1024px）：左上角触发、左侧滑出的竖向列表。
 * 替代窄屏上的桌面活动栏；Esc/遮罩关闭，Tab 焦点在菜单内循环。
 */
export function MobileNavMenu({ open, onClose, activeView, problemsBadge = 0, notificationsBadge = 0, onShowView, onShowHelp, onShowNotifications, onOpenSettings }: RailActions & { open: boolean; onClose(): void }): ReactElement | null {
  const { t } = useI18n();
  const navRef = useRef<HTMLElement>(null);

  // 打开时焦点进菜单；Esc 关闭（遮罩点击由 backdrop onClick 承担）；Tab 在菜单内循环（不逃到遮罩下的内容）
  useEffect(() => {
    if (!open) return undefined;
    const nav = navRef.current;
    nav?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        // 焦点陷阱：Tab/Shift+Tab 在菜单内循环，阻止焦点逃到 aria-hidden 遮罩下的页面内容
        if (event.key === "Tab" && nav) {
          const focusables = nav.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (event.shiftKey) {
            if (active === first || !nav.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else if (active === last || !nav.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const action = (run: () => void) => (): void => {
    run();
    onClose();
  };

  return (
    <>
      <div className="mobile-nav-backdrop" aria-hidden onClick={onClose} />
      <nav ref={navRef} className="mobile-nav" tabIndex={-1} aria-label={t("导航菜单", "Navigation menu")}>
        <div className="mobile-nav-group">
          {(Object.keys(VIEW_META) as SidebarView[]).map((view) => {
            const meta = VIEW_META[view];
            const active = activeView === view;
            return (
              <button
                key={view}
                type="button"
                className={`mobile-nav-item${active ? " active" : ""}`}
                aria-pressed={active}
                onClick={action(() => onShowView(view))}
              >
                <Icon name={meta.icon} size={18} />
                {t(meta.zh, meta.en)}
                {view === "problems" && problemsBadge > 0 && (
                  <span className="activity-badge" aria-label={t(`${problemsBadge} 个新问题`, `${problemsBadge} new problem(s)`)}>{problemsBadge}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mobile-nav-group mobile-nav-group-bottom">
          <button type="button" className="mobile-nav-item" onClick={action(onShowHelp)}>
            <Icon name="help" size={18} />
            {t("帮助与快捷键", "Help & shortcuts")}
          </button>
          <button type="button" className="mobile-nav-item" onClick={action(onShowNotifications)}>
            <Icon name="bell" size={18} />
            {t("通知中心", "Notifications")}
            {notificationsBadge > 0 && (
              <span className="activity-badge" aria-hidden>{notificationsBadge > 99 ? "99+" : notificationsBadge}</span>
            )}
          </button>
          <button type="button" className="mobile-nav-item" onClick={action(onOpenSettings)}>
            <Icon name="settings" size={18} />
            {t("设置", "Settings")}
          </button>
        </div>
      </nav>
    </>
  );
}
