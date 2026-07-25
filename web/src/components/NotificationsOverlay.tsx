/**
 * 通知中心浮层（0.4.0 Phase 5b §6.6）：可回看的通知列表。
 * 懒加载独立 chunk；未读高亮、逐条清除、全部清除、点击跳转相关会话/视图。
 * 列表语义用 role="list"/"listitem"，条目全文可被屏幕阅读器朗读。
 */
import type { ReactElement } from "react";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";
import type { AppNotification } from "../lib/notifications";

function timeLabel(at: number, locale: "zh-CN" | "en-US"): string {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function NotificationsOverlay({ open, notifications, onActivate, onDismiss, onClearAll, onClose }: {
  open: boolean;
  notifications: AppNotification[];
  /** 点击条目：跳转目标会话/视图（同时标记已读并关闭） */
  onActivate(item: AppNotification): void;
  onDismiss(id: string): void;
  onClearAll(): void;
  onClose(): void;
}): ReactElement | null {
  const { t, locale } = useI18n();
  if (!open) return null;

  return (
    <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-overlay notifications-overlay" role="dialog" aria-modal="true" aria-label={t("通知中心", "Notifications")}>
        <header className="wb-overlay-header">
          <h2>{t("通知中心", "Notifications")}</h2>
          {notifications.length > 0 && (
            <button className="btn small" onClick={onClearAll}>{t("全部清除", "Clear all")}</button>
          )}
          <button className="icon-btn" aria-label={t("关闭", "Close")} onClick={onClose}>✕</button>
        </header>
        {notifications.length === 0 ? (
          <p className="panel-empty">{t("暂无通知。后台任务完成、诊断与源代码管理更新会出现在这里。", "No notifications. Background task completions, diagnostics, and source control updates appear here.")}</p>
        ) : (
          <ul className="notifications-list" role="list" aria-label={t("通知列表", "Notification list")}>
            {notifications.map((item) => (
              <li key={item.id} className={`notification-item${item.read ? "" : " unread"}`} data-kind={item.kind} role="listitem">
                <button
                  type="button"
                  className="notification-body"
                  onClick={() => onActivate(item)}
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
                  onClick={() => onDismiss(item.id)}
                >
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="wb-overlay-hint">{t("按 Esc 关闭；权限请求与结构化交互仍以卡片形式出现在对话轨道中。", "Press Esc to close. Permission requests and structured interactions still appear as cards in the conversation track.")}</p>
      </div>
    </div>
  );
}
