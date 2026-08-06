/**
 * 移动端导航（≤1024px）：左上角 logo 按钮触发、从左侧水平滑出的竖向菜单。
 * 替代窄屏上的桌面活动栏：上组为侧栏视图切换（会话/文件/SCM/问题），下组为帮助/通知/终端/设置入口。
 * MobileNavMenu：带文案的完整菜单；MobileNavRail：点选视图后收缩成的纯图标栏，
 * 右侧整屏展示对应面板（会话列表/文件/SCM/问题），再点当前视图图标或遮罩/Esc 关闭。
 */
import { useEffect, useRef, type ReactElement } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import type { SidebarView } from "./useWorkbenchLayout";
import { VIEW_META } from "./view-meta";

/** 菜单与图标栏共用的入口参数 */
export interface MobileNavActions {
  activeView: SidebarView;
  problemsBadge?: number;
  notificationsBadge?: number;
  terminalDisabled?: boolean;
  /** 终端标签选中态：高亮当前所在区 */
  terminalActive?: boolean;
  /** 设置页内复用本图标栏时高亮设置入口 */
  settingsActive?: boolean;
  onShowView(view: SidebarView): void;
  onShowHelp(): void;
  onShowNotifications(): void;
  onOpenTerminal(): void;
  onOpenSettings(): void;
  onClose(): void;
}

/** 左上角触发按钮（移动端渲染，桌面端由 CSS 隐藏）：面板图标 + 边框胶囊，明确可点击 */
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

export function MobileNavMenu({ open, activeView, problemsBadge = 0, notificationsBadge = 0, terminalDisabled = false, terminalActive = false, onShowView, onShowHelp, onShowNotifications, onOpenTerminal, onOpenSettings, onClose }: {
  open: boolean;
} & MobileNavActions): ReactElement | null {
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
          } else {
            if (active === last || !nav.contains(active)) {
              event.preventDefault();
              first.focus();
            }
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
          <button
            type="button"
            className={`mobile-nav-item${terminalActive ? " active" : ""}`}
            disabled={terminalDisabled}
            onClick={action(onOpenTerminal)}
          >
            <Icon name="terminal" size={18} />
            {t("终端", "Terminal")}
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

/**
 * 图标栏（面板模式）：菜单点选视图后收缩成的纯图标竖条，右侧整屏为面板内容。
 * 视图图标：切换面板（当前视图再点一次关闭）；下组入口：执行并关闭。Esc/遮罩由 App 承担。
 */
export function MobileNavRail({ activeView, problemsBadge = 0, notificationsBadge = 0, terminalDisabled = false, terminalActive = false, settingsActive = false, onShowView, onShowHelp, onShowNotifications, onOpenTerminal, onOpenSettings, onClose }: MobileNavActions): ReactElement {
  const { t } = useI18n();

  const action = (run: () => void) => (): void => {
    run();
    onClose();
  };

  return (
    <nav className="mobile-explorer-rail" aria-label={t("导航", "Navigation")}>
      <div className="mobile-explorer-rail-top">
        {(Object.keys(VIEW_META) as SidebarView[]).map((view) => {
          const meta = VIEW_META[view];
          // 设置页内复用本图标栏时只有「设置」高亮，视图不高亮（当前所在区是设置）
          const active = activeView === view && !settingsActive;
          return (
            <button
              key={view}
              type="button"
              className={`activity-btn${active ? " active" : ""}`}
              aria-label={t(meta.zh, meta.en)}
              title={t(meta.zh, meta.en)}
              aria-pressed={active}
              onClick={() => onShowView(view)}
            >
              <Icon name={meta.icon} size={18} />
              {view === "problems" && problemsBadge > 0 && (
                <span className="activity-badge" aria-label={t(`${problemsBadge} 个新问题`, `${problemsBadge} new problem(s)`)}>{problemsBadge}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mobile-explorer-rail-bottom">
        <button type="button" className="activity-btn" aria-label={t("帮助与快捷键", "Help & shortcuts")} title={t("帮助与快捷键", "Help & shortcuts")} onClick={action(onShowHelp)}>
          <Icon name="help" size={18} />
        </button>
        <button type="button" className="activity-btn" aria-label={t("通知中心", "Notifications")} title={t("通知中心", "Notifications")} onClick={action(onShowNotifications)}>
          <Icon name="bell" size={18} />
          {notificationsBadge > 0 && (
            <span className="activity-badge" aria-hidden>{notificationsBadge > 99 ? "99+" : notificationsBadge}</span>
          )}
        </button>
        <button
          type="button"
          className={`activity-btn${terminalActive ? " active" : ""}`}
          aria-label={t("终端", "Terminal")}
          title={t("终端", "Terminal")}
          disabled={terminalDisabled}
          onClick={action(onOpenTerminal)}
        >
          <Icon name="terminal" size={18} />
        </button>
        <button type="button" className={`activity-btn${settingsActive ? " active" : ""}`} aria-label={t("设置", "Settings")} title={t("设置", "Settings")} aria-pressed={settingsActive || undefined} onClick={action(onOpenSettings)}>
          <Icon name="settings" size={18} />
        </button>
      </div>
    </nav>
  );
}
