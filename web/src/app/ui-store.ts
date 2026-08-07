import { createStore } from "./store";
import {
  clearNotifications, markAllRead, markRead, pushNotification, removeNotification,
  type AppNotification, type NotificationKind, type NotificationTarget,
} from "../lib/notifications";
import type { SettingsTab } from "../lib/contracts";

/** Toast 单条提示（kind 决定配色与 role；error 用 role=alert） */
export interface Notice {
  kind: NotificationKind;
  text: string;
}

/**
 * 全局 UI 状态：导航/对话框/覆盖层/提示与通知中心。
 * 服务端数据一律走 react-query，不进这里；按会话键控的运行态在 session-store。
 */
export interface UiState {
  /** 当前选中会话；undefined 表示未选择（展示欢迎页） */
  sessionId?: string;
  newSessionOpen: boolean;
  settingsOpen: boolean;
  /** 设置深链目标页签 + 触发序号（同一页签重复深链也能重新定位） */
  settingsTab?: { tab: SettingsTab; at: number };
  paletteOpen: boolean;
  quickOpen: boolean;
  /** 删除会话确认框目标 */
  deleteTarget?: string;
  notice?: Notice;
  notifications: AppNotification[];
}

const INITIAL_UI_STATE: UiState = {
  newSessionOpen: false,
  settingsOpen: false,
  paletteOpen: false,
  quickOpen: false,
  notifications: [],
};

export const uiStore = createStore<UiState>(INITIAL_UI_STATE);

/** 任意浮层/对话框处于打开状态（供命令 when 条件 "!dialogOpen" 等使用） */
export function anyDialogOpen(state: UiState): boolean {
  return state.newSessionOpen || state.settingsOpen || state.paletteOpen || state.quickOpen;
}

export const ui = {
  selectSession(sessionId: string | undefined): void {
    uiStore.set({ sessionId });
  },
  setNewSessionOpen(open: boolean): void {
    uiStore.set({ newSessionOpen: open });
  },
  openSettings(tab?: SettingsTab): void {
    uiStore.set({ settingsOpen: true, settingsTab: tab === undefined ? undefined : { tab, at: Date.now() } });
  },
  closeSettings(): void {
    uiStore.set({ settingsOpen: false });
  },
  setPaletteOpen(open: boolean): void {
    uiStore.set({ paletteOpen: open });
  },
  setQuickOpen(open: boolean): void {
    uiStore.set({ quickOpen: open });
  },
  setDeleteTarget(sessionId: string | undefined): void {
    uiStore.set({ deleteTarget: sessionId });
  },
  setNotice(notice: Notice | undefined): void {
    uiStore.set({ notice });
  },
  /** 失败类提示用 error（红色、role=alert），成功/进度类用 info；同时汇入通知中心 */
  notify(text: string, kind: NotificationKind = "info"): void {
    uiStore.set((previous) => ({
      notice: { kind, text },
      notifications: pushNotification(previous.notifications, { kind, text }),
    }));
  },
  /** 后台事件进通知流（可带跳转目标），不弹 toast 打扰 */
  pushEventNotification(text: string, kind: NotificationKind, target?: NotificationTarget): void {
    uiStore.set((previous) => ({
      notifications: pushNotification(previous.notifications, { kind, text, ...(target ? { target } : {}) }),
    }));
  },
  markNotificationRead(id: string): void {
    uiStore.set((previous) => ({ notifications: markRead(previous.notifications, id) }));
  },
  markAllNotificationsRead(): void {
    uiStore.set((previous) => ({ notifications: markAllRead(previous.notifications) }));
  },
  removeNotification(id: string): void {
    uiStore.set((previous) => ({ notifications: removeNotification(previous.notifications, id) }));
  },
  clearNotifications(): void {
    uiStore.set({ notifications: clearNotifications() });
  },
};
