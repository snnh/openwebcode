/**
 * 通知中心（设置页签形态，原 NotificationsOverlay 浮层并入）：可回看的通知列表。
 * 未读高亮、逐条清除、全部清除、点击跳转相关会话/视图；进入页签即全部标记已读（角标清零）。
 * 列表语义用 role="list"/"listitem"，条目全文可被屏幕阅读器朗读。
 */
import { useEffect, type ReactElement } from "react";
import { Icon } from "../../components/Icon";
import { ui, uiStore } from "../../app/ui-store";
import { useStore } from "../../app/store";
import { layout } from "../../workbench/layout";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../../hooks/use-media-query";
import { useI18n } from "../../i18n";
import type { AppNotification } from "../../lib/notifications";

function timeLabel(at: number, locale: "zh-CN" | "en-US"): string {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function NotificationsSection(): ReactElement {
  const { t, locale } = useI18n();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const notifications = useStore(uiStore, (state) => state.notifications);

  // 进入页签即全部标记已读（角标清零；挂载时触发一次）
  useEffect(() => {
    ui.markAllNotificationsRead();
  }, []);

  // 点击条目：标记已读 + 关设置 + 跳转目标会话/侧栏视图/设置页签
  const activate = (item: AppNotification): void => {
    ui.markNotificationRead(item.id);
    ui.closeSettings();
    if (item.target?.sessionId) ui.selectSession(item.target.sessionId);
    if (item.target?.view) {
      if (isMobile) {
        layout.selectView(item.target.view);
        layout.setMobileSidebarOpen(true);
      } else {
        layout.showView(item.target.view);
      }
    }
    if (item.target?.settingsTab) ui.openSettings(item.target.settingsTab);
  };

  return (
    <section aria-label={t("通知中心", "Notifications")}>
      {notifications.length > 0 && (
        <div className="notifications-actions">
          <button className="btn small" onClick={() => ui.clearNotifications()}>{t("全部清除", "Clear all")}</button>
        </div>
      )}
      {notifications.length === 0 ? (
        <p className="muted-empty">{t("暂无通知。后台任务完成、诊断与源代码管理更新会出现在这里。", "No notifications. Background task completions, diagnostics, and source control updates appear here.")}</p>
      ) : (
        <ul className="notifications-list" role="list" aria-label={t("通知列表", "Notification list")}>
          {notifications.map((item) => (
            <li key={item.id} className={`notification-item${item.read ? "" : " unread"}`} data-kind={item.kind} role="listitem">
              <button
                type="button"
                className="notification-body"
                onClick={() => activate(item)}
                aria-label={item.target ? t(`${item.text}（点击跳转）`, `${item.text} (activate to jump)`) : item.text}
              >
                <span className="notification-text">{item.text}</span>
                <span className="notification-meta">
                  {item.kind === "error" && <span className="notification-kind">{t("错误", "Error")}</span>}
                  <time dateTime={new Date(item.at).toISOString()}>{timeLabel(item.at, locale)}</time>
                </span>
              </button>
              <button
                type="button"
                className="icon-btn notification-dismiss"
                aria-label={t("清除该通知", "Dismiss this notification")}
                onClick={() => ui.removeNotification(item.id)}
              >
                <Icon name="x" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted-empty">{t("权限请求与结构化交互仍以卡片形式出现在对话轨道中。", "Permission requests and structured interactions still appear as cards in the conversation track.")}</p>
    </section>
  );
}
