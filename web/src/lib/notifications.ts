/**
 * 通知中心数据层（0.4.0 Phase 5b §6.6）：
 * 汇总 toast 提示与后台事件（agent 完成、诊断更新、SCM 更新、后台任务结束）
 * 为可回看列表。纯函数 + App 内 useState 持有，不引外部状态库。
 * 权限请求与结构化交互不进入通知流（保持一等卡片语义）。
 */

export type NotificationKind = "info" | "error";

/** 点击通知的跳转目标：会话 + 可选侧栏视图，或设置对话框的指定页签（SettingsTab） */
export interface NotificationTarget {
  sessionId?: string;
  view?: "sessions" | "files" | "scm" | "problems";
  settingsTab?: string;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  text: string;
  /** 产生时间（epoch ms） */
  at: number;
  read: boolean;
  target?: NotificationTarget;
}

/** 列表上限：超出丢弃最旧条目，避免长会话内存膨胀 */
export const NOTIFICATION_LIMIT = 50;

let sequence = 0;

export function pushNotification(
  list: readonly AppNotification[],
  input: { kind: NotificationKind; text: string; target?: NotificationTarget; at?: number },
): AppNotification[] {
  const item: AppNotification = {
    id: `n${Date.now().toString(36)}-${(sequence += 1)}`,
    kind: input.kind,
    text: input.text,
    at: input.at ?? Date.now(),
    read: false,
    ...(input.target ? { target: input.target } : {}),
  };
  return [item, ...list].slice(0, NOTIFICATION_LIMIT);
}

export function unreadCount(list: readonly AppNotification[]): number {
  return list.reduce((count, item) => count + (item.read ? 0 : 1), 0);
}

export function markAllRead(list: readonly AppNotification[]): AppNotification[] {
  if (list.every((item) => item.read)) return [...list];
  return list.map((item) => (item.read ? item : { ...item, read: true }));
}

export function markRead(list: readonly AppNotification[], id: string): AppNotification[] {
  return list.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item));
}

export function removeNotification(list: readonly AppNotification[], id: string): AppNotification[] {
  return list.filter((item) => item.id !== id);
}

export function clearNotifications(): AppNotification[] {
  return [];
}
